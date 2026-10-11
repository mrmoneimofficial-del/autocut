/** Re-run detectSilences on the STORED envelope with the STORED settings and
 *  compare its regions with the STORED decisionsJson regions. */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { parseEnvelope } from '../src/lib/autocut/envelope'
import { detectSilences } from '../src/lib/autocut/engine'
import type { Decisions, DetectionSettings } from '../src/lib/autocut/types'

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const STORE = '/home/z/my-project/storage/autocut'

const jobs = [
  { id: '153d9ec5-096c-45b0-b3c7-c62439cbdd7f', name: 'v1' },
  { id: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', name: 'v2' },
  { id: '2b57ba0b-7ec6-41f4-8e17-42dbe8c2c19c', name: 'v3' },
]

for (const job of jobs) {
  const row = db.query('SELECT decisionsJson, settingsJson FROM autocut_jobs WHERE id = ?').get(job.id) as any
  const dec: Decisions = JSON.parse(row.decisionsJson)
  const settings: DetectionSettings = JSON.parse(row.settingsJson)
  const env = parseEnvelope(fs.readFileSync(`${STORE}/${job.id}/envelope.bin`))

  const t0 = Date.now()
  const result = detectSilences(env, settings)
  const fresh = result.regions.filter(r => r.kind === 'silence')
  const stored = dec.regions.filter(r => r.kind === 'silence')

  console.log(`\n===== ${job.name} =====`)
  console.log(`engine run: ${Date.now() - t0}ms | fresh silence regions: ${fresh.length} | stored: ${stored.length}`)
  console.log(`envelope: frames=${env.frames} (${(env.frames * env.frameMs / 60000).toFixed(1)} min) effTh=${result.effectiveThresholdDb} noiseFloor=${result.envelope.noiseFloorDb}`)

  // compare around the known-bad spots
  const spots = job.name === 'v2' ? [155380, 8305740] : job.name === 'v1' ? [1515000] : [296000]
  for (const s of spots) {
    console.log(`--- near ${s}ms:`)
    for (const r of fresh.filter(r => Math.abs(r.startMs - s) < 3000)) console.log(`  FRESH ${JSON.stringify(r)}`)
    for (const r of stored.filter(r => Math.abs(r.startMs - s) < 3000)) console.log(`  STORE ${JSON.stringify(r)}`)
  }

  // count how many stored regions cover audible speech vs fresh
  const audible = (start: number, end: number) => {
    let n = 0
    for (let f = Math.ceil(start / 20); f <= Math.floor(end / 20); f++) {
      if (env.rmsDb[f] > -37) n++ // any frame louder than the silence gate
    }
    return n * 20
  }
  let storedBad = 0, freshBad = 0
  for (const r of stored) if (audible(r.cutStartMs + 100, r.cutEndMs) > 200) storedBad++
  for (const r of fresh) if (audible(r.cutStartMs + 100, r.cutEndMs) > 200) freshBad++
  console.log(`stored regions with >200ms of >-37dB material inside removal: ${storedBad}/${stored.length}`)
  console.log(`FRESH  regions with >200ms of >-37dB material inside removal: ${freshBad}/${fresh.length}`)
}
db.close()
