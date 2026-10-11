/** Final report numbers: per-video damage classification + verifiable timestamps. */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { parseEnvelope } from '../src/lib/autocut/envelope'
import { removedSpansFromDecisions } from '../src/lib/autocut/planner'
import type { Decisions } from '../src/lib/autocut/types'

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const STORE = '/home/z/my-project/storage/autocut'

const JOBS = [
  { id: '153d9ec5-096c-45b0-b3c7-c62439cbdd7f', name: 'video1898711759 (81.9→56.5 دقيقة)' },
  { id: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', name: 'video1313774023 (149.3→109.8 دقيقة)' },
  { id: '2b57ba0b-7ec6-41f4-8e17-42dbe8c2c19c', name: 'video1692308323 (25.6→18.0 دقيقة)' },
]

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

for (const job of JOBS) {
  const row = db.query('SELECT decisionsJson, metaJson FROM autocut_jobs WHERE id = ?').get(job.id) as any
  const dec: Decisions = JSON.parse(row.decisionsJson)
  const meta = JSON.parse(row.metaJson || '{}')
  const env = parseEnvelope(fs.readFileSync(`${STORE}/${job.id}/envelope.bin`))
  const spans = removedSpansFromDecisions(dec, meta.durationMs)

  let cum = 0
  const rows = spans.map(sp => {
    const cumBefore = cum; cum += sp.endMs - sp.startMs
    const f0 = Math.ceil(sp.startMs / 20), f1 = Math.floor(sp.endMs / 20)
    let best = 0, cur = 0, curStrong = 0, bestStrong = 0, strongMs = 0
    for (let f = f0; f <= f1; f++) {
      const loud = env.peakDb[f] > -40
      const strong = env.peakDb[f] > -33 && env.rmsDb[f] > -42
      cur = loud ? cur + 1 : 0
      curStrong = strong ? curStrong + 1 : 0
      if (cur > best) best = cur
      if (curStrong > bestStrong) bestStrong = curStrong
      if (strong) strongMs++
    }
    return {
      out: sp.endMs - cumBefore, len: sp.endMs - sp.startMs,
      run: best * 20, runStrong: bestStrong * 20, strongMs: strongMs * 20,
    }
  })

  const phrase = rows.filter(r => r.runStrong >= 400)   // ≥400ms continuous strong speech removed
  const word = rows.filter(r => r.runStrong >= 150 && r.runStrong < 400)
  const totalStrong = rows.reduce((a, r) => a + r.strongMs, 0)
  console.log(`\n### ${job.name}`)
  console.log(`عدد القصادات: ${spans.length}`)
  console.log(`قصادات بلعت جملة كاملة (≥400ms كلام متواصل): ${phrase.length}`)
  console.log(`قصادات بلعت كلمة/جزء كلمة (150-400ms): ${word.length}`)
  console.log(`إجمالي الكلام الواضح المتشال: ${(totalStrong / 1000).toFixed(1)} ثانية`)
  const top = [...rows].sort((a, b) => b.runStrong - a.runStrong).slice(0, 6)
  console.log(`أسوأ لحظات (في الفيديو المُسلَّم):`)
  for (const t of top) console.log(`  ${fmt(t.out)} — كلام متواصل متشال ${t.runStrong}ms`)
}
db.close()
