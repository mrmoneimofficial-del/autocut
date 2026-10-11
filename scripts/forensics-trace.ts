/** Conclusive trace: replicate engine stages B/E/F on the exact frames of
 *  region r32 (v2, orig 155.38→157.40) to show HOW a speech phrase became
 *  one merged "silence" region. Plus final report numbers. */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { parseEnvelope } from '../src/lib/autocut/envelope'
import type { DetectionSettings } from '../src/lib/autocut/types'

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const row = db.query('SELECT settingsJson FROM autocut_jobs WHERE id = ?').get('d26ef7bc-af52-4d77-8341-d1474b8ff2cb') as any
const settings: DetectionSettings = JSON.parse(row.settingsJson)
const env = parseEnvelope(fs.readFileSync('/home/z/my-project/storage/autocut/d26ef7bc-af52-4d77-8341-d1474b8ff2cb/envelope.bin'))

const effTh = settings.thresholdDb // -35 (noiseFloor -87.7, range 71.6 → no lift)
const FR0 = Math.floor(155000 / 20), FR1 = Math.ceil(157800 / 20)

// Stage B
const silent = new Uint8Array(env.frames), spike = new Uint8Array(env.frames)
for (let i = 0; i < env.frames; i++) {
  if (env.rmsDb[i] < effTh - 2) silent[i] = 1
  if (env.peakDb[i] > effTh + 10 || env.rmsDb[i] > effTh + 3) spike[i] = 1
}
// (protections: none fire inside this window — verified by the engine's own output)

// Stage E: core runs + absorption (mirror engine logic)
const runs: Array<{ start: number; end: number }> = []
let s = -1
for (let i = FR0; i < FR1; i++) {
  if (silent[i]) { if (s < 0) s = i } else if (s >= 0) { runs.push({ start: s, end: i }); s = -1 }
}
if (s >= 0) runs.push({ start: s, end: FR1 })

const ABSORB = 350 / 20
const cands: Array<{ start: number; end: number }> = []
for (const run of runs) {
  let start = run.start, end = run.end
  let i = start - 1, ms = 0
  while (i >= FR0 && ms < ABSORB) {
    if (silent[i] || env.peakDb[i] > effTh + 6) break
    ms++; i--
  }
  start = i + 1
  i = end; ms = 0
  while (i < FR1 && ms < ABSORB) {
    if (silent[i] || env.peakDb[i] > effTh + 6) break
    ms++; i++
  }
  end = i
  cands.push({ start, end })
}

console.log('=== CORE SILENT RUNS + absorption inside 155.0→157.8s (speech phrase at ~156.3→157.35) ===')
for (const c of cands) {
  const gapSpeech = []
  for (let f = c.start; f < c.end; f++) if (!silent[f]) gapSpeech.push(f)
  console.log(`  run ${(c.start * 0.02).toFixed(2)}→${(c.end * 0.02).toFixed(2)}s (${(c.end - c.start) * 20}ms)` +
    (gapSpeech.length ? `  [contains ${gapSpeech.length * 20}ms of NON-silent frames]` : ''))
}

// Stage F merge chain
console.log('\n=== MERGE CHAIN (gap <= 180ms bridges LOUD syllables) ===')
let merged: Array<{ start: number; end: number; mergedAcross: string[] }> = []
for (const run of cands) {
  const last = merged[merged.length - 1]
  if (last) {
    const gapMs = (run.start - last.end) * 20
    if (gapMs <= 180) {
      // what's in the gap?
      let loudestPeak = -100, loudestRms = -100
      for (let f = last.end; f < run.start; f++) {
        if (env.peakDb[f] > loudestPeak) loudestPeak = env.peakDb[f]
        if (env.rmsDb[f] > loudestRms) loudestRms = env.rmsDb[f]
      }
      last.mergedAcross.push(`gap ${(last.end * 0.02).toFixed(2)}→${(run.start * 0.02).toFixed(2)} (${gapMs}ms, loud as peak ${loudestPeak.toFixed(0)}dB / rms ${loudestRms.toFixed(0)}dB)`)
      last.end = Math.max(last.end, run.end)
      continue
    }
  }
  merged.push({ ...run, mergedAcross: [] })
}
for (const m of merged) {
  console.log(`  MERGED region ${(m.start * 0.02).toFixed(2)}→${(m.end * 0.02).toFixed(2)}s (${(m.end - m.start) * 20}ms):`)
  for (const g of m.mergedAcross) console.log(`     bridged over: ${g}`)
}

db.close()
