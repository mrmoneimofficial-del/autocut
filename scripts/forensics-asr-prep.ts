/** Extract ASR verification clips for the worst eaten-speech joins.
 *  For each: (a) the exact REMOVED audio from the ORIGINAL (the eaten words),
 *            (b) the original context window,
 *            (c) the same context window from the OUTPUT (should miss words).
 */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { removedSpansFromDecisions } from '../src/lib/autocut/planner'
import type { Decisions } from '../src/lib/autocut/types'

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const STORE = '/home/z/my-project/storage/autocut'
const OUT = '/home/z/my-project/tool-results/asr-clips'
fs.mkdirSync(OUT, { recursive: true })

// (jobId, tag, span start in ORIGINAL ms)
const targets: Array<{ id: string; tag: string; spanStart: number }> = [
  { id: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', tag: 'v2_join1', spanStart: 155660 },
  { id: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', tag: 'v2_join2', spanStart: 8305960 },
  { id: '2b57ba0b-7ec6-41f4-8e17-42dbe8c2c19c', tag: 'v3_join1', spanStart: 296300 },
]

function ff(args: string[]) {
  const p = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args])
  if (p.exitCode !== 0) console.log('FFMPEG FAIL:', p.stderr.toString().slice(0, 300))
}

for (const t of targets) {
  const row = db.query('SELECT decisionsJson, metaJson FROM autocut_jobs WHERE id = ?').get(t.id) as any
  const dec: Decisions = JSON.parse(row.decisionsJson)
  const meta = JSON.parse(row.metaJson || '{}')
  const spans = removedSpansFromDecisions(dec, meta.durationMs)
  const idx = spans.findIndex(s => Math.abs(s.startMs - t.spanStart) < 150)
  if (idx < 0) { console.log(`${t.tag}: span not found`); continue }
  const sp = spans[idx]
  const cumBefore = spans.slice(0, idx).reduce((a, s) => a + (s.endMs - s.startMs), 0)
  const outJoinMs = sp.endMs - cumBefore
  const removedMs = sp.endMs - sp.startMs

  console.log(`\n===== ${t.tag} =====`)
  console.log(`removed span orig [${(sp.startMs / 1000).toFixed(2)}s → ${(sp.endMs / 1000).toFixed(2)}s] (${(removedMs / 1000).toFixed(2)}s) | output join at ${(outJoinMs / 1000).toFixed(2)}s`)

  // (a) the eaten material itself: the audible part of the removed span
  const eatFrom = (sp.startMs + 120) / 1000
  const eatTo = sp.endMs / 1000
  ff(['-ss', eatFrom.toFixed(3), '-t', (eatTo - eatFrom).toFixed(3), '-i', `${STORE}/${t.id}/original.mp4`,
      '-vn', '-ar', '16000', '-ac', '1', `${OUT}/${t.tag}_eaten.wav`])

  // (b) original context: 1.2s before span → 3.8s after span end
  const oFrom = Math.max(0, (sp.startMs - 1200) / 1000)
  const oDur = (sp.endMs + 3800) / 1000 - oFrom
  ff(['-ss', oFrom.toFixed(3), '-t', oDur.toFixed(3), '-i', `${STORE}/${t.id}/original.mp4`,
      '-vn', '-ar', '16000', '-ac', '1', `${OUT}/${t.tag}_orig.wav`])

  // (c) output context: same window mapped to output timeline
  const outFrom = Math.max(0, (outJoinMs - 1200) / 1000)
  ff(['-ss', outFrom.toFixed(3), '-t', oDur.toFixed(3), '-i', `${STORE}/${t.id}/output.mp4`,
      '-vn', '-ar', '16000', '-ac', '1', `${OUT}/${t.tag}_out.wav`])

  for (const f of [`${t.tag}_eaten.wav`, `${t.tag}_orig.wav`, `${t.tag}_out.wav`]) {
    const st = fs.statSync(`${OUT}/${f}`)
    console.log(`  ${f}: ${(st.size / 1024).toFixed(0)} KB`)
  }
}
db.close()
console.log('\nclips ready in', OUT)
