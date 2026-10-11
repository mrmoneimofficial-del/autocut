/** Dump envelope frames + region data around the worst spans to debug the timeline. */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { parseEnvelope } from '../src/lib/autocut/envelope'
import { removedSpansFromDecisions } from '../src/lib/autocut/planner'
import type { Decisions } from '../src/lib/autocut/types'

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const STORE = '/home/z/my-project/storage/autocut'

// v2 worst early span (orig ~0:02:35) and late span (orig ~2:18:30)
const checks = [
  { jobId: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', name: 'v2', aroundMs: 156000 },
  { jobId: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', name: 'v2', aroundMs: 8310000 },
  { jobId: '2b57ba0b-7ec6-41f4-8e17-42dbe8c2c19c', name: 'v3', aroundMs: 297000 },
]

for (const c of checks) {
  const row = db.query(`SELECT decisionsJson, metaJson, detectionJson FROM autocut_jobs WHERE id = ?`).get(c.jobId) as any
  const dec: Decisions = JSON.parse(row.decisionsJson)
  const meta = JSON.parse(row.metaJson || '{}')
  const env = parseEnvelope(fs.readFileSync(`${STORE}/${c.jobId}/envelope.bin`))
  const spans = removedSpansFromDecisions(dec, meta.durationMs)
  const det = JSON.parse(row.detectionJson)

  const near = spans.filter(s => s.startMs < c.aroundMs + 4000 && s.endMs > c.aroundMs - 4000)
  console.log(`\n===== ${c.name} around ${c.aroundMs}ms | effTh ${det.effectiveThresholdDb} | env frames ${env.frames} (${(env.frames * env.frameMs / 60000).toFixed(1)} min) =====`)
  for (const sp of near) {
    console.log(`span ${Math.round(sp.startMs)}→${Math.round(sp.endMs)} (${Math.round(sp.endMs - sp.startMs)}ms)`)
    const reg = dec.regions.find(r => r.kind === 'silence' && Math.abs(r.startMs - sp.startMs) < 200)
    if (reg) console.log(`  region: start ${reg.startMs} end ${reg.endMs} cutStart ${reg.cutStartMs} cutEnd ${reg.cutEndMs} conf ${reg.confidence} depth ${reg.depthDb}`)
    const f0 = Math.max(0, Math.floor((sp.startMs - 1200) / 20))
    const f1 = Math.min(env.frames - 1, Math.ceil((sp.endMs + 1200) / 20))
    let line = ''
    for (let f = f0; f <= f1; f++) {
      const t = f * 20
      const mark = t >= sp.startMs && t < sp.endMs ? (t >= sp.startMs + 100 ? '#' : '+') : ' '
      line += `${mark}${(t / 1000).toFixed(2)}s R${env.rmsDb[f].toFixed(0)} P${env.peakDb[f].toFixed(0)}  `
      if ((f - f0) % 4 === 3) { console.log('   ' + line); line = '' }
    }
    if (line) console.log('   ' + line)
  }
}
db.close()
