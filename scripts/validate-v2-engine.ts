/**
 * VALIDATION of the v2 engine fixes (Stage E absorption, Stage F dead-air
 * merge guard, Stage H snap bias/guard, Stage C syllable softening).
 *
 * Runs the NEW detectSilences over each job's cached envelope with the exact
 * stored settings, builds the decisions exactly like the detect route, then
 * measures how much audible/strong speech would still land inside the removed
 * spans — the same metrics that proved the v1 engine was eating speech.
 *
 * Baseline (v1 engine, measured):  strong speech removed
 *   v1 100,140 ms   v2 202,520 ms   v3 37,480 ms
 * Target: near zero. Also verifies the two known swallowed v2 phrases are
 * fully preserved, and prints new region/savings statistics.
 */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { parseEnvelope } from '../src/lib/autocut/envelope'
import { detectSilences } from '../src/lib/autocut/engine'
import { removedSpansFromDecisions } from '../src/lib/autocut/planner'
import type { CutRegion, Decisions, DetectionSettings } from '../src/lib/autocut/types'

const DB = '/home/z/my-project/db/custom.db'
const STORE = '/home/z/my-project/storage/autocut'

const JOBS = [
  { id: '153d9ec5-096c-45b0-b3c7-c62439cbdd7f', name: 'v1 video1898711759', oldStrong: 100140, oldSpans: 701 },
  { id: 'd26ef7bc-af52-4d77-8341-d1474b8ff2cb', name: 'v2 video1313774023', oldStrong: 202520, oldSpans: 1554 },
  { id: '2b57ba0b-7ec6-41f4-8e17-42dbe8c2c19c', name: 'v3 video1692308323', oldStrong: 37480, oldSpans: 237 },
]

const AUDIBLE_PEAK = -40
const STRONG_PEAK = -33
const STRONG_RMS = -42

// known swallowed phrases (original-timeline, from the forensic audit) that
// must be FULLY preserved by the new decisions
const KNOWN_PHRASES: Record<string, Array<{ label: string; from: number; to: number }>> = {
  'd26ef7bc-af52-4d77-8341-d1474b8ff2cb': [
    { label: '"Can it itself, costar da."', from: 155_380, to: 157_400 },
    { label: '"Get local cost, what is it?"', from: 8_305_960, to: 8_307_700 },
  ],
}

const db = new Database(DB, { readonly: true })

function fmt(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

let allOk = true

for (const job of JOBS) {
  const row = db
    .query('SELECT settingsJson, metaJson FROM autocut_jobs WHERE id = ?')
    .get(job.id) as any
  const settings = JSON.parse(row.settingsJson) as DetectionSettings
  const meta = JSON.parse(row.metaJson || '{}')
  const durationMs = meta.durationMs as number

  const env = parseEnvelope(fs.readFileSync(`${STORE}/${job.id}/envelope.bin`))
  const result = detectSilences(env, settings)
  const fm = env.frameMs

  // build decisions exactly like the detect route
  const regions: CutRegion[] = result.regions
  const decisions: Decisions = {
    regions,
    targetSilenceMs: settings.targetSilenceMs,
    render: { fadeMs: 12, renderMode: 'precision' },
  }
  const spans = removedSpansFromDecisions(decisions, durationMs)
  const totalRemoved = spans.reduce((a, s) => a + (s.endMs - s.startMs), 0)

  // ---- eaten-speech measurement over the NEW removed spans ----
  let audibleMs = 0
  let strongMs = 0
  let maxPeak = -100
  let longestRun = 0
  let runNow = 0
  let phraseSwallows = 0 // contiguous audible run >= 400ms
  let wordChops = 0 // contiguous audible run 150-400ms
  const worst: Array<{ at: number; runMs: number; peak: number }> = []
  for (const s of spans) {
    let spanAudible = 0
    let spanStrong = 0
    let spanRun = 0
    let spanMaxPeak = -100
    for (let t = s.startMs; t < s.endMs; t += fm) {
      const i = Math.min(env.frames - 1, Math.round(t / fm))
      if (i < 0) continue
      const p = env.peakDb[i]
      const r = env.rmsDb[i]
      if (p > maxPeak) maxPeak = p
      if (p > spanMaxPeak) spanMaxPeak = p
      if (p > AUDIBLE_PEAK) {
        audibleMs += fm
        spanAudible += fm
        runNow += fm
        spanRun += fm
        if (r > STRONG_RMS && p > STRONG_PEAK) {
          strongMs += fm
          spanStrong += fm
        }
      } else {
        if (runNow >= 400) phraseSwallows++
        else if (runNow >= 150) wordChops++
        if (runNow > 0) worst.push({ at: s.startMs, runMs: runNow, peak: spanMaxPeak })
        runNow = 0
        spanRun = 0
        spanMaxPeak = -100
      }
      if (spanRun > longestRun) longestRun = spanRun
    }
    void spanAudible; void spanStrong
  }
  if (runNow >= 400) phraseSwallows++
  else if (runNow >= 150) wordChops++

  // ---- known-phrase preservation check (SPEECH overlap, not geometric) ----
  const phraseChecks = (KNOWN_PHRASES[job.id] ?? []).map((ph) => {
    let eatenSpeechMs = 0
    for (let t = ph.from; t < ph.to; t += fm) {
      const i = Math.min(env.frames - 1, Math.round(t / fm))
      if (env.peakDb[i] > AUDIBLE_PEAK) {
        // audible frame of the phrase — is it inside a removed span?
        if (spans.some((s) => t >= s.startMs && t < s.endMs)) eatenSpeechMs += fm
      }
    }
    return { ...ph, eatenMs: eatenSpeechMs }
  })

  const savedPct = ((totalRemoved / durationMs) * 100).toFixed(1)
  const finalMin = (durationMs - totalRemoved) / 60000
  const silenceCount = regions.filter((r) => r.kind === 'silence').length

  console.log(`\n=== ${job.name} ===`)
  console.log(
    `regions: ${silenceCount} (was ${job.oldSpans}) | removed spans: ${spans.length} | savings: ${savedPct}% | final: ${finalMin.toFixed(1)} min`
  )
  console.log(
    `STRONG speech inside removed: ${strongMs} ms (v1 engine: ${job.oldStrong} ms) — ${strongMs === 0 ? 'CLEAN' : 'CHECK'}`
  )
  console.log(
    `audible(>-40dB): ${audibleMs} ms | longest audible run: ${longestRun} ms | max peak: ${maxPeak.toFixed(1)} dB`
  )
  console.log(`phrase-swallows(>=400ms): ${phraseSwallows} | word-chops(150-400ms): ${wordChops}`)
  for (const pc of phraseChecks) {
    console.log(`  phrase ${pc.label} [${fmt(pc.from)}–${fmt(pc.to)}]: ${pc.eatenMs === 0 ? 'PRESERVED ✓' : `STILL EATEN ${pc.eatenMs}ms ✗`}`)
    if (pc.eatenMs > 0) allOk = false
  }
  if (strongMs > 500 || phraseSwallows > 0) allOk = false
}

console.log(`\n${allOk ? '>>> VALIDATION PASSED — safe to re-render' : '>>> VALIDATION FAILED — do NOT render'}`)
