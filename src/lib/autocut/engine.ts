/**
 * AutoCut silence detection engine.
 *
 * This is NOT a naive "volume below X = silence" pass. It is a multi-stage
 * pipeline combining RMS level, true-peak level, noise-floor estimation,
 * spike density (syllables in quiet speech), envelope shape (breath
 * signatures) and duration reasoning. It runs over the cached loudness
 * envelope, so it costs milliseconds even for a 4-hour video, and every
 * parameter change can be re-evaluated instantly.
 *
 * Stages:
 *   A. Noise floor / dynamic range estimation (percentile sampling)
 *   B. Frame classification: silent / quiet / spike
 *   C. Low-volume speech protection (quiet stretch with syllable spikes)
 *   D. Breath protection (short, flat, noise-like stretches near speech)
 *   E. Silence runs, absorbing adjacent quiet frames
 *   F. Merge runs split by tiny blips (< 180 ms of non-silence)
 *   G. Duration filters (min / max silence)
 *   H. Boundaries: keep-before/after padding, smart padding snap,
 *      maximum-removal cap
 *
 * The engine is pure and modular on purpose — VAD/ML classification can be
 * slotted in at stage B later without touching the rest of the pipeline.
 */

import type { CutRegion, DetectionSettings, EnvelopeInfo } from './types'
import type { EnvelopeData } from './envelope'

export interface EngineResult {
  regions: CutRegion[]
  envelope: EnvelopeInfo
  effectiveThresholdDb: number
}

const MS = (frames: number, frameMs: number) => frames * frameMs
const FR = (ms: number, frameMs: number) => Math.round(ms / frameMs)

function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return -100
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))
  return sorted[idx]
}

/** Collect maximal runs of frames matching a predicate. */
interface Run {
  start: number // frame index inclusive
  end: number // frame index exclusive
}

function runsWhere(
  count: number,
  pred: (i: number) => boolean
): Run[] {
  const runs: Run[] = []
  let s = -1
  for (let i = 0; i < count; i++) {
    if (pred(i)) {
      if (s < 0) s = i
    } else if (s >= 0) {
      runs.push({ start: s, end: i })
      s = -1
    }
  }
  if (s >= 0) runs.push({ start: s, end: count })
  return runs
}

export function detectSilences(env: EnvelopeData, settings: DetectionSettings): EngineResult {
  const { rmsDb, peakDb, frameMs, frames } = env
  const durationMs = MS(frames, frameMs)
  const info: EnvelopeInfo = {
    frameMs,
    frames,
    durationMs,
    noiseFloorDb: -100,
    dynamicRangeDb: 0,
  }
  if (frames === 0) return { regions: [], envelope: info, effectiveThresholdDb: settings.thresholdDb }

  // ---------------------------------------------------------------- Stage A
  // Noise floor & dynamic range from a bounded sample of frames.
  const stride = Math.max(1, Math.floor(frames / 60000))
  const sample = new Float32Array(Math.ceil(frames / stride))
  for (let i = 0, j = 0; i < frames; i += stride, j++) sample[j] = rmsDb[i]
  sample.sort()
  const noiseFloorDb = percentile(sample, 0.1)
  const loudCeilDb = percentile(sample, 0.95)
  const dynamicRangeDb = loudCeilDb - noiseFloorDb
  info.noiseFloorDb = Math.round(noiseFloorDb * 10) / 10
  info.dynamicRangeDb = Math.round(dynamicRangeDb * 10) / 10

  // With a noisy room, a plain threshold sits below the room tone and nothing
  // is ever detected — or above it and everything is. Tolerance lifts the
  // effective threshold just over the measured floor.
  let effTh = settings.thresholdDb
  if (settings.noiseTolerance && noiseFloorDb > -55 && dynamicRangeDb < 45) {
    effTh = Math.max(effTh, noiseFloorDb + 4)
  }

  // ---------------------------------------------------------------- Stage B
  // Frame classification.
  //   silent — PEAK below the effective threshold. This is the strict
  //            mathematical guarantee: a frame whose peak (max sample) is
  //            under the threshold contains ZERO samples above it, so it can
  //            never carry audible speech at the user's setting. (v3 engine:
  //            the old rms < effTh-2 conjunct excluded quiet dead air —
  //            rms between effTh-2 and effTh with peak under effTh — which
  //            padded every pause and left large inter-sentence gaps.
  //            rms ≤ peak always, so peak alone is both necessary and
  //            sufficient for the nothing-above-threshold guarantee.)
  //   spike  — definite activity (peak well above threshold)
  //   quiet  — in between: word tails, breaths, room tone fluctuations
  const silent = new Uint8Array(frames)
  const spike = new Uint8Array(frames)
  for (let i = 0; i < frames; i++) {
    const r = rmsDb[i]
    const p = peakDb[i]
    if (p < effTh) silent[i] = 1
    if (p > effTh + 10 || r > effTh + 3) spike[i] = 1
  }

  // Marks for protected material (excluded from silence candidates).
  const protectedSpeech = new Uint8Array(frames)
  const protectedBreath = new Uint8Array(frames)

  // ---------------------------------------------------------------- Stage C
  // Low-volume speech: quiet stretches that still carry syllable spikes.
  // Whispered/soft speech must not be classified as silence. Only the
  // neighborhoods of actual syllables are protected — a quiet stretch that is
  // merely silence with transition smear at its edges stays cuttable.
  if (settings.lowSpeechProtection) {
    const quietish = (i: number) => rmsDb[i] < effTh + 6 && peakDb[i] < effTh + 16
    // effTh+6 (was +8): softer syllables still count — protects whispered
    // onsets whose peaks barely clear the threshold
    const isSyllable = (i: number) => peakDb[i] > effTh + 6
    const runs = runsWhere(frames, (i) => quietish(i))
    const K = FR(400, frameMs) // protection radius around each syllable
    for (const run of runs) {
      const lenMs = MS(run.end - run.start, frameMs)
      if (lenMs < 350) continue
      const syllableFrames: number[] = []
      for (let i = run.start; i < run.end; i++) if (isSyllable(i)) syllableFrames.push(i)
      if (syllableFrames.length < 2) continue
      for (const s of syllableFrames) {
        const a = Math.max(run.start, s - K)
        const b = Math.min(run.end, s + 1 + K)
        for (let i = a; i < b; i++) protectedSpeech[i] = 1
      }
    }
  }

  // ---------------------------------------------------------------- Stage D
  // Breaths: short (150–900 ms), flat, noise-like stretches adjacent to
  // speech. A breath has a low peak-to-RMS ratio (noise-like) unlike
  // consonants/vowels which are peaky.
  if (settings.breathingProtection) {
    const quietRuns = runsWhere(frames, (i) => !silent[i] && !spike[i] && !protectedSpeech[i])
    const isSpeechNear = (frameIdx: number, windowFrames: number) => {
      const a = Math.max(0, frameIdx - windowFrames)
      const b = Math.min(frames, frameIdx + windowFrames)
      for (let i = a; i < b; i++) if (spike[i] || protectedSpeech[i]) return true
      return false
    }
    for (const run of quietRuns) {
      const lenMs = MS(run.end - run.start, frameMs)
      if (lenMs < 150 || lenMs > 900) continue
      let sumR = 0
      let sumP = 0
      for (let i = run.start; i < run.end; i++) {
        sumR += rmsDb[i]
        sumP += peakDb[i]
      }
      const meanR = sumR / (run.end - run.start)
      const meanP = sumP / (run.end - run.start)
      const prRatio = meanP - meanR
      const nearSpeech = isSpeechNear(run.start, FR(600, frameMs)) || isSpeechNear(run.end, FR(600, frameMs))
      if (nearSpeech && meanR > effTh - 2 && meanR < effTh + 14 && prRatio < 12) {
        for (let i = run.start; i < run.end; i++) protectedBreath[i] = 1
      }
    }
  }

  // ---------------------------------------------------------------- Stage E
  // Candidate silence runs: consecutive silent frames, absorbing adjacent
  // quiet (non-protected, low-energy) frames up to 350 ms per side.
  // SAFETY (v2 engine): absorption may only cover frames whose PEAK is still
  // below the classification boundary (effTh - 2). Previously frames peaking
  // up to effTh + 6 were absorbed — that ate soft word onsets/tails (audible
  // /f/, /w/, breathy consonant edges up to ~100 ms per join). RMS can never
  // exceed PEAK, so this bound subsumes any RMS bound: everything absorbed is
  // genuinely sub-threshold, i.e. inaudible.
  const absorbed = new Uint8Array(frames) // quiet frames folded into a run
  // v3: with peak-gated classification, every sub-threshold frame is already
  // "silent", so protection marks (which cover inaudible frames inside
  // whisper stretches) no longer exclude anything from the core runs — the
  // peak gate itself is the guarantee. Protection arrays remain for the
  // informational regions and the merge guard below.
  const coreRuns = runsWhere(frames, (i) => silent[i] === 1)
  const ABSORB_MS = 350
  const candidates: Run[] = []
  for (const run of coreRuns) {
    let start = run.start
    let end = run.end
    // absorb left
    let i = start - 1
    let absorbedMs = 0
    while (i >= 0 && absorbedMs < ABSORB_MS) {
      if (silent[i] || protectedSpeech[i] || protectedBreath[i]) break
      if (peakDb[i] > effTh - 2) break // near/above threshold — possible soft word edge, stop
      absorbed[i] = 1
      absorbedMs += frameMs
      i--
    }
    start = i + 1
    // absorb right
    i = end
    absorbedMs = 0
    while (i < frames && absorbedMs < ABSORB_MS) {
      if (silent[i] || protectedSpeech[i] || protectedBreath[i]) break
      if (peakDb[i] > effTh - 2) break
      absorbed[i] = 1
      absorbedMs += frameMs
      i++
    }
    end = i
    candidates.push({ start, end })
  }
  candidates.sort((a, b) => a.start - b.start)

  // ---------------------------------------------------------------- Stage F
  // Merge runs separated by a blip shorter than 180 ms (clicks, coughs,
  // lip smacks inside dead air). A NEGATIVE gap means the left/right quiet
  // absorption consumed the whole gap — those runs must merge too, or the
  // regions would overlap. Never merge across protected material.
  //
  // SAFETY (v2 engine — THE critical fix): the gap itself must be
  // indistinguishable from dead air before a merge is allowed. Inter-syllable
  // dips inside continuous speech are classified as "silent" frames (rms
  // dips below effTh-2 for 40–80 ms at natural speech cadence); the old code
  // bridged the LOUD voiced syllables between those dips (gaps ≤ 180 ms) and
  // chain-merged entire spoken phrases into one "silence" region, deleting
  // them from the output. Now every frame of the gap must sit below the
  // silence classification boundary (rms ≤ effTh-2) AND carry no significant
  // transient (peak ≤ effTh+6) — otherwise the gap is kept verbatim.
  const MERGE_MS = Math.min(180, settings.minSilenceMs / 2)
  const merged: Run[] = []
  for (const run of candidates) {
    const last = merged[merged.length - 1]
    if (last) {
      const gap = run.start - last.end
      const gapHasProtection = (() => {
        for (let i = Math.max(0, last.end); i < Math.min(frames, run.start); i++) {
          if (protectedSpeech[i] || protectedBreath[i]) return true
        }
        return false
      })()
      // v2: the gap must be true dead air — every frame strictly below the
      // threshold BY PEAK (≤ effTh-2, matching the absorption bound). Soft
      // interjections ("yeah" at -33 dB), clicks, pops and plosives all stay.
      const gapIsDeadAir = (() => {
        for (let i = Math.max(0, last.end); i < Math.min(frames, run.start); i++) {
          if (rmsDb[i] > effTh - 2) return false // voiced syllable — NEVER bridge
          if (peakDb[i] > effTh - 2) return false // click / pop / soft word — keep it
        }
        return true
      })()
      if (MS(gap, frameMs) <= MERGE_MS && !gapHasProtection && gapIsDeadAir) {
        last.end = Math.max(last.end, run.end)
        last.start = Math.min(last.start, run.start)
        continue
      }
    }
    merged.push({ ...run })
  }

  // ---------------------------------------------------------------- Stage G
  // Duration filters.
  const kept = merged.filter((r) => {
    const lenMs = MS(r.end - r.start, frameMs)
    if (lenMs < settings.minSilenceMs) return false
    if (settings.maxSilenceMs != null && lenMs > settings.maxSilenceMs) return false
    return true
  })

  // ---------------------------------------------------------------- Stage H
  // Boundaries: padding, smart snap, removal cap.
  const regions: CutRegion[] = []
  const snapSafe = (nominalFrame: number, direction: -1 | 1): number => {
    // Find the lowest-energy frame within ±120 ms where the guard window on
    // the speech side is also quiet, preferring the point closest to speech
    // (so we never eat a word).
    const win = FR(120, frameMs)
    let best = nominalFrame
    let bestVal = Infinity
    for (let d = -win; d <= win; d++) {
      const f = nominalFrame + d
      if (f < 0 || f >= frames) continue
      const guardDir = direction === -1 ? 1 : -1 // guard looks toward the speech side
      let ok = true
      for (let g = 1; g <= Math.max(1, FR(60, frameMs)); g++) {
        const gf = f + guardDir * g
        if (gf < 0 || gf >= frames) continue
        // v2: peak guard tightened from effTh+6 to effTh — the removed-side
        // neighbour of a snap position must be truly quiet, not merely
        // "below effTh+6" (which still chopped -30 dB word edges).
        if (rmsDb[gf] > effTh - 3 || peakDb[gf] > effTh) {
          ok = false
          break
        }
      }
      if (!ok) continue
      // v2: prefer the SAFE side (start later / end earlier = remove less).
      // The old bias preferred maximum removal and pushed cuts into the
      // absorbed quiet edges of neighbouring words.
      const bias = direction === -1 ? -d * 0.5 : d * 0.5
      const score = rmsDb[f] + bias
      if (score < bestVal) {
        bestVal = score
        best = f
      }
    }
    return best
  }

  for (const run of kept) {
    const startMs = MS(run.start, frameMs)
    const endMs = MS(run.end, frameMs)
    let cutStartMs = startMs + settings.keepBeforeMs
    let cutEndMs = endMs - settings.keepAfterMs

    if (settings.smartPadding) {
      const fs = FR(cutStartMs, frameMs)
      const fe = FR(cutEndMs, frameMs)
      const snappedS = snapSafe(fs, -1)
      const snappedE = snapSafe(fe, 1)
      if (snappedS >= run.start && snappedS < run.end) cutStartMs = MS(snappedS, frameMs)
      if (snappedE > run.start && snappedE <= run.end) cutEndMs = MS(snappedE, frameMs)
    }

    // Full removal window after padding.
    if (cutEndMs - cutStartMs < 40) continue // padding covers the whole silence → keep it

    // Maximum removal cap — shrink symmetrically so a natural pause survives.
    if (settings.maxRemovalMs != null) {
      const removable = cutEndMs - cutStartMs
      if (removable > settings.maxRemovalMs) {
        const excess = removable - settings.maxRemovalMs
        cutStartMs += excess / 2
        cutEndMs -= excess / 2
      }
    }

    let sumR = 0
    for (let i = run.start; i < run.end; i++) sumR += rmsDb[i]
    const meanR = sumR / (run.end - run.start)
    const depthDb = Math.max(0, effTh - meanR)
    const lenMs = endMs - startMs
    const confidence = Math.max(
      0.05,
      Math.min(1, (depthDb / 12) * Math.min(1, lenMs / 1500 + 0.4))
    )

    regions.push({
      id: `r${regions.length}-${Math.round(startMs)}`,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      cutStartMs: Math.round(cutStartMs),
      cutEndMs: Math.round(cutEndMs),
      action: settings.compressSilence ? 'compress' : 'remove',
      kind: 'silence',
      confidence: Math.round(confidence * 100) / 100,
      depthDb: Math.round(depthDb * 10) / 10,
    })
  }

  // Informational protected regions (kept, visible for review).
  const pushInfo = (mark: Uint8Array, kind: 'breath' | 'lowspeech') => {
    const runs = runsWhere(frames, (i) => mark[i] === 1)
    for (const run of runs) {
      const startMs = MS(run.start, frameMs)
      const endMs = MS(run.end, frameMs)
      regions.push({
        id: `p${regions.length}-${Math.round(startMs)}`,
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        cutStartMs: Math.round(startMs),
        cutEndMs: Math.round(endMs),
        action: 'keep',
        kind,
        confidence: 0.9,
      })
    }
  }
  pushInfo(protectedBreath, 'breath')
  pushInfo(protectedSpeech, 'lowspeech')
  regions.sort((a, b) => a.startMs - b.startMs)

  return { regions, envelope: info, effectiveThresholdDb: effTh }
}
