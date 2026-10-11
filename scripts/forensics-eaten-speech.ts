/**
 * FORENSIC ANALYSIS — "eaten speech" audit of the 3 delivered videos.
 * NO modification of any file. Read-only measurement:
 *   1. Load the ACTUAL render decisions (decisionsJson) for each job.
 *   2. Rebuild the exact removed spans (same code path as the render planner).
 *   3. For every removed span, measure how much AUDIBLE material (from the
 *      original audio's own RMS/peak envelope, 20 ms frames) was inside it:
 *        - headChopMs : audible frames contiguous with the LEFT join
 *                       (word tail chopped off mid-fade)
 *        - tailChopMs : audible frames contiguous with the RIGHT join
 *                       (word onset / first syllable eaten)
 *        - audibleMs  : total ms with peak > -40 dB inside the removed span
 *        - strongMs   : ms with peak > -33 dB AND rms > -42 dB (speech-level)
 *        - longestRun : longest contiguous audible run inside the span
 *                       (possibly a whole swallowed interjection)
 *        - maxPeakDb  : loudest peak inside the removed span
 *   4. Map each join to the OUTPUT timeline so the user can seek & listen.
 */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { parseEnvelope } from '../src/lib/autocut/envelope'
import { removedSpansFromDecisions } from '../src/lib/autocut/planner'
import type { Decisions } from '../src/lib/autocut/types'

const DB = '/home/z/my-project/db/custom.db'
const STORE = '/home/z/my-project/storage/autocut'

const JOBS = [
  { id: '153d9ec5-096c-45b0-b3c7-c62439cbdd7f', name: 'v1 video1898711759' },
  { id: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', name: 'v2 video1313774023' },
  { id: '2b57ba0b-7ec6-41f4-8e17-42dbe8c2c19c', name: 'v3 video1692308323' },
]

const AUDIBLE_PEAK = -40 // dB peak: clearly audible quiet speech / breath
const STRONG_PEAK = -33  // dB peak: definite speech energy
const STRONG_RMS = -42

const db = new Database(DB, { readonly: true })

function fmt(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

const allWorst: Array<{
  video: string, jobId: string, spanIdx: number,
  origCutEnd: number, outJoin: number,
  headChop: number, tailChop: number, longestRun: number,
  audibleMs: number, strongMs: number, maxPeak: number, spanLen: number,
}> = []

for (const job of JOBS) {
  const row = db.query(
    `SELECT decisionsJson, settingsJson, metaJson, outputDuration, envelopeBytes FROM autocut_jobs WHERE id = ?`
  ).get(job.id) as any
  if (!row?.decisionsJson) { console.log(`!! no decisions for ${job.name}`); continue }

  const dec: Decisions = JSON.parse(row.decisionsJson)
  const meta = JSON.parse(row.metaJson || '{}')
  const durationMs = meta.durationMs as number
  const target = dec.targetSilenceMs ?? 100

  const envRaw = fs.readFileSync(`${STORE}/${job.id}/envelope.bin`)
  const env = parseEnvelope(envRaw)
  const fm = env.frameMs

  // exact spans the render removed (same code as the worker)
  const spans = removedSpansFromDecisions(dec, durationMs)
  const totalRemoved = spans.reduce((a, s) => a + (s.endMs - s.startMs), 0)

  const silenceRegions = dec.regions.filter(r => r.kind === 'silence')
  const compressRegions = silenceRegions.filter(r => r.action === 'compress' || r.action === 'remove')

  // cumulative removal for original->output time mapping
  let cum = 0
  const cumBefore: number[] = spans.map(s => { const c = cum; cum += s.endMs - s.startMs; return c })

  interface Row {
    spanIdx: number, startMs: number, endMs: number, len: number,
    headChop: number, tailChop: number, longestRun: number,
    audibleMs: number, strongMs: number, maxPeak: number, maxRms: number,
    outJoin: number,
  }
  const rows: Row[] = []

  spans.forEach((sp, idx) => {
    const f0 = Math.max(0, Math.ceil(sp.startMs / fm))
    const f1 = Math.min(env.frames - 1, Math.floor(sp.endMs / fm))
    if (f1 <= f0) return
    let audible = 0, strong = 0, maxPeak = -100, maxRms = -100
    const aud: boolean[] = []
    for (let f = f0; f <= f1; f++) {
      const p = env.peakDb[f], r = env.rmsDb[f]
      const a = p > AUDIBLE_PEAK
      aud.push(a)
      if (a) audible++
      if (p > STRONG_PEAK && r > STRONG_RMS) strong++
      if (p > maxPeak) maxPeak = p
      if (r > maxRms) maxRms = r
    }
    // longest contiguous audible run
    let best = 0, cur = 0
    for (const a of aud) { cur = a ? cur + 1 : 0; if (cur > best) best = cur }
    // head chop: audible frames starting at f0
    let h = 0; while (h < aud.length && aud[h]) h++
    // tail chop: audible frames ending at f1
    let t = 0; while (t < aud.length && aud[aud.length - 1 - t]) t++
    rows.push({
      spanIdx: idx, startMs: sp.startMs, endMs: sp.endMs, len: sp.endMs - sp.startMs,
      headChop: h * fm, tailChop: t * fm, longestRun: best * fm,
      audibleMs: audible * fm, strongMs: strong * fm, maxPeak, maxRms,
      outJoin: sp.endMs - cumBefore[idx],
    })
  })

  const n = rows.length
  const withAudible = rows.filter(r => r.audibleMs > 0).length
  const audGT100 = rows.filter(r => r.audibleMs > 100).length
  const audGT300 = rows.filter(r => r.audibleMs > 300).length
  const onsetGT60 = rows.filter(r => r.tailChop >= 60).length
  const onsetGT120 = rows.filter(r => r.tailChop >= 120).length
  const onsetGT240 = rows.filter(r => r.tailChop >= 240).length
  const endGT60 = rows.filter(r => r.headChop >= 60).length
  const endGT120 = rows.filter(r => r.headChop >= 120).length
  const runGT150 = rows.filter(r => r.longestRun >= 150).length
  const strongGT100 = rows.filter(r => r.strongMs > 100).length
  const totalAudMs = rows.reduce((a, r) => a + r.audibleMs, 0)
  const totalStrongMs = rows.reduce((a, r) => a + r.strongMs, 0)
  const loudPeak = rows.filter(r => r.maxPeak > -29).length

  console.log(`\n================ ${job.name} ================`)
  console.log(`duration: ${(durationMs / 60000).toFixed(1)} min | removed spans: ${n} | total removed: ${(totalRemoved / 60000).toFixed(1)} min | target gap: ${target}ms`)
  console.log(`silence regions detected: ${silenceRegions.length} (cut ${compressRegions.length})`)
  console.log(`removed spans containing AUDIBLE (peak>-40dB) material: ${withAudible}/${n} (${(withAudible / n * 100).toFixed(1)}%)`)
  console.log(`  > 100ms audible removed : ${audGT100} spans`)
  console.log(`  > 300ms audible removed : ${audGT300} spans`)
  console.log(`  strong speech (peak>-33 & rms>-42) > 100ms: ${strongGT100} spans`)
  console.log(`  spans with peak > -29dB inside (LOUD material!): ${loudPeak}`)
  console.log(`ONSET  eaten (audible touching right join): >=60ms: ${onsetGT60} | >=120ms: ${onsetGT120} | >=240ms: ${onsetGT240}`)
  console.log(`ENDING chopped (audible touching left join): >=60ms: ${endGT60} | >=120ms: ${endGT120}`)
  console.log(`longest internal audible run >=150ms (swallowed words?): ${runGT150}`)
  console.log(`TOTAL audible material removed: ${(totalAudMs / 1000).toFixed(1)}s | strong-speech material: ${(totalStrongMs / 1000).toFixed(1)}s`)

  // worst examples
  const worst = [...rows].sort((a, b) =>
    (Math.max(b.tailChop, 0) * 2 + Math.max(b.headChop, 0) + b.longestRun + b.strongMs / 50) -
    (Math.max(a.tailChop, 0) * 2 + Math.max(a.headChop, 0) + a.longestRun + a.strongMs / 50)
  ).slice(0, 8)
  console.log(`\nWORST joins (seek here in the OUTPUT video):`)
  for (const w of worst) {
    console.log(`  out ${fmt(w.outJoin)} | orig pause ${fmt(w.startMs)}→${fmt(w.endMs)} (len ${(w.len / 1000).toFixed(1)}s) | onsetEaten ${w.tailChop}ms | endChopped ${w.headChop}ms | longestRun ${w.longestRun}ms | audible ${(w.audibleMs / 1000).toFixed(2)}s | strong ${(w.strongMs / 1000).toFixed(2)}s | maxPeak ${w.maxPeak.toFixed(1)}dB`)
    allWorst.push({
      video: job.name, jobId: job.id, spanIdx: w.spanIdx,
      origCutEnd: w.endMs, outJoin: w.outJoin,
      headChop: w.headChop, tailChop: w.tailChop, longestRun: w.longestRun,
      audibleMs: w.audibleMs, strongMs: w.strongMs, maxPeak: w.maxPeak, spanLen: w.len,
    })
  }
}

// global worst for ASR spot-checks
allWorst.sort((a, b) => (b.tailChop * 2 + b.longestRun + b.strongMs / 50) - (a.tailChop * 2 + a.longestRun + a.strongMs / 50))
console.log(`\n===== GLOBAL TOP-6 FOR ASR VERIFICATION =====`)
fs.writeFileSync('/home/z/my-project/tool-results/forensics_top.json', JSON.stringify(allWorst.slice(0, 6), null, 2))
for (const w of allWorst.slice(0, 6)) {
  console.log(`${w.video} | out ${fmt(w.outJoin)} | orig ${fmt(w.origCutEnd)} | onset ${w.tailChop}ms | run ${w.longestRun}ms | strong ${(w.strongMs / 1000).toFixed(2)}s | maxPeak ${w.maxPeak.toFixed(1)}dB`)
}
db.close()
