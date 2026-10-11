/**
 * Client-side timeline geometry: mapping between original video time and the
 * processed (auto-cut) timeline. Used for virtual preview playback (skipping
 * removed spans live on the original stream — no rendering required) and for
 * drawing the playhead on the timeline.
 */

import type { CutRegion, Decisions, KeepSegment, RemovedSpan } from './types'
import { removedSpanFor } from './planner'

export interface ProcessedMap {
  removedSpans: RemovedSpan[]
  keepSegments: KeepSegment[]
  durationMs: number
  finalDurationMs: number
}

export function buildProcessedMap(decisions: Decisions | null, durationMs: number): ProcessedMap {
  if (!decisions || durationMs <= 0) {
    return { removedSpans: [], keepSegments: durationMs > 0 ? [{ startMs: 0, endMs: durationMs }] : [], durationMs, finalDurationMs: durationMs }
  }
  const spans: RemovedSpan[] = []
  for (const r of decisions.regions) {
    if (r.kind === 'breath' || r.kind === 'lowspeech') continue
    const s = removedSpanFor(r, decisions.targetSilenceMs)
    if (s && s.endMs - s.startMs >= 20) spans.push(s)
  }
  spans.sort((a, b) => a.startMs - b.startMs)
  // merge
  const merged: RemovedSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, s.endMs)
    else merged.push({ ...s })
  }
  const keep: KeepSegment[] = []
  let cursor = 0
  for (const s of merged) {
    if (s.startMs > cursor) keep.push({ startMs: cursor, endMs: s.startMs })
    cursor = Math.max(cursor, s.endMs)
  }
  if (cursor < durationMs) keep.push({ startMs: cursor, endMs: durationMs })
  const finalDurationMs = keep.reduce((a, s) => a + (s.endMs - s.startMs), 0)
  return { removedSpans: merged, keepSegments: keep, durationMs, finalDurationMs }
}

/** Original time → processed time. Inside a removed span maps to its start. */
export function originalToProcessed(map: ProcessedMap, tMs: number): number {
  let removedBefore = 0
  for (const s of map.removedSpans) {
    if (s.startMs >= tMs) break
    if (s.endMs <= tMs) {
      removedBefore += s.endMs - s.startMs
    } else {
      // inside the span — collapse to the span start
      return s.startMs - removedBefore
    }
  }
  return tMs - removedBefore
}

/** Processed time → original time (where to seek the video element). */
export function processedToOriginal(map: ProcessedMap, pMs: number): number {
  let acc = 0
  for (const s of map.keepSegments) {
    const len = s.endMs - s.startMs
    if (pMs <= acc + len) return s.startMs + (pMs - acc)
    acc += len
  }
  return map.durationMs
}

/** If t is inside a removed span, returns the span; otherwise null. */
export function removedSpanAt(map: ProcessedMap, tMs: number, toleranceMs = 30): RemovedSpan | null {
  for (const s of map.removedSpans) {
    if (tMs >= s.startMs - toleranceMs && tMs < s.endMs - toleranceMs * 0.5) return s
    if (s.startMs > tMs) break
  }
  return null
}

/** Jump helpers: previous / next cut boundary relative to a time. */
export function nextCutStart(map: ProcessedMap, tMs: number): number | null {
  for (const s of map.removedSpans) if (s.startMs > tMs + 50) return s.startMs
  return null
}

export function prevCutStart(map: ProcessedMap, tMs: number): number | null {
  let found: number | null = null
  for (const s of map.removedSpans) {
    if (s.startMs < tMs - 50) found = s.startMs
    else break
  }
  return found
}

/** Region under a given original time (for click-to-select). */
export function regionAt(regions: CutRegion[], tMs: number): CutRegion | null {
  for (const r of regions) {
    if (tMs >= r.startMs && tMs <= r.endMs) return r
    if (r.startMs > tMs) break
  }
  return null
}
