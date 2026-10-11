/**
 * Render planner — turns reviewed decisions into the final keep-segment list
 * used by the worker's FFmpeg pipeline, plus statistics and safety checks.
 * Shared verbatim between the API (validation, stats) and the worker.
 */

import type { CutRegion, Decisions, DetectionStats, JobError, KeepSegment, RemovedSpan, RenderPlan } from './types'
import { isSmartKind } from './types'

export interface Span {
  startMs: number
  endMs: number
}

function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs)
  const out: Span[] = [{ ...sorted[0] }]
  for (const s of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (s.startMs <= last.endMs + 1) {
      last.endMs = Math.max(last.endMs, s.endMs)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

/** Removed span for a region given the active compress target. */
export function removedSpanFor(region: CutRegion, globalTargetMs: number): Span | null {
  if (region.action === 'keep') return null
  if (region.action === 'remove') {
    const s = region.cutStartMs
    const e = region.cutEndMs
    return e - s >= 20 ? { startMs: s, endMs: e } : null
  }
  // compress: keep the first `target` of the silence, remove the rest
  const target = region.targetMs ?? globalTargetMs
  const s = region.cutStartMs + Math.max(0, target)
  const e = region.cutEndMs
  return e - s >= 20 ? { startMs: s, endMs: e } : null
}

export function removedSpansFromDecisions(decisions: Decisions, durationMs: number): Span[] {
  const spans: Span[] = []
  for (const r of decisions.regions) {
    if (r.kind === 'breath' || r.kind === 'lowspeech') continue // informational only
    const span = removedSpanFor(r, decisions.targetSilenceMs)
    if (!span) continue
    spans.push({
      startMs: Math.max(0, Math.min(durationMs, span.startMs)),
      endMs: Math.max(0, Math.min(durationMs, span.endMs)),
    })
  }
  return mergeSpans(spans.filter((s) => s.endMs - s.startMs >= 20))
}

export function complementSegments(spans: Span[], durationMs: number, minSegMs = 40): KeepSegment[] {
  const keep: KeepSegment[] = []
  let cursor = 0
  for (const s of spans) {
    if (s.startMs > cursor) keep.push({ startMs: cursor, endMs: s.startMs })
    cursor = Math.max(cursor, s.endMs)
  }
  if (cursor < durationMs) keep.push({ startMs: cursor, endMs: durationMs })
  // Merge segments separated by less than minSegMs (tiny slivers are encoder-hostile)
  const merged: KeepSegment[] = []
  for (const seg of keep) {
    const last = merged[merged.length - 1]
    if (last && seg.startMs - last.endMs < minSegMs) {
      last.endMs = Math.max(last.endMs, seg.endMs)
    } else {
      merged.push({ ...seg })
    }
  }
  // Drop degenerate segments
  return merged.filter((s) => s.endMs - s.startMs >= minSegMs)
}

export function statsFromSpans(spans: Span[], decisions: Decisions, durationMs: number): DetectionStats {
  const silenceRegions = decisions.regions.filter((r) => r.kind === 'silence')
  const totalSilenceMs = silenceRegions.reduce((a, r) => a + (r.endMs - r.startMs), 0)
  const willRemoveMs = spans.reduce((a, s) => a + (s.endMs - s.startMs), 0)
  const finalDurationMs = Math.max(0, durationMs - willRemoveMs)
  const savedPct = durationMs > 0 ? (willRemoveMs / durationMs) * 100 : 0
  return {
    regionCount: silenceRegions.length,
    totalSilenceMs: Math.round(totalSilenceMs),
    willRemoveMs: Math.round(willRemoveMs),
    finalDurationMs: Math.round(finalDurationMs),
    savedPct: Math.round(savedPct * 10) / 10,
  }
}

export function buildRenderPlan(decisions: Decisions, durationMs: number): RenderPlan {
  const warnings: string[] = []
  let fatal: JobError | null = null

  const spans = removedSpansFromDecisions(decisions, durationMs)
  const keepSegments = complementSegments(spans, durationMs)
  const stats = statsFromSpans(spans, decisions, durationMs)

  if (stats.finalDurationMs < 5000 && durationMs > 15000) {
    fatal = {
      code: 'TOO_MUCH_REMOVED',
      message: `These settings would remove ${stats.savedPct.toFixed(
        1
      )}% of the video — essentially everything. Adjust the settings before rendering.`,
    }
  } else {
    if (stats.savedPct > 65) {
      warnings.push(
        `Your current settings remove ${stats.savedPct.toFixed(
          1
        )}% of the video. Review the detected cuts carefully before rendering — most of the timeline would be removed.`
      )
    } else if (stats.savedPct > 40) {
      warnings.push(
        `Your current settings remove ${stats.savedPct.toFixed(
          1
        )}% of the video. Review the detected cuts before rendering.`
      )
    }
    if (stats.regionCount > 0 && stats.totalSilenceMs > durationMs * 0.85) {
      warnings.push(
        'The audio contains almost no usable speech — most of the timeline was classified as silence. Check the sensitivity setting.'
      )
    }
    if (spans.length === 0) {
      warnings.push('No cuts are active — the output will be an exact stream copy of the original (zero quality loss).')
    }
  }

  const removedSpans: RemovedSpan[] = spans.map((s) => ({ startMs: s.startMs, endMs: s.endMs }))
  return { keepSegments, removedSpans, stats, warnings, fatal }
}

/** Validate + sanitize user decisions before storing / rendering. */
export function validateDecisions(decisions: Decisions, durationMs: number): string | null {
  if (!Array.isArray(decisions.regions)) return 'regions must be an array'
  if (decisions.regions.length > 20000) return 'too many regions'
  if (!decisions.render || !['precision', 'fast'].includes(decisions.render.renderMode)) {
    return 'invalid render mode'
  }
  const fade = decisions.render.fadeMs
  if (typeof fade !== 'number' || fade < 0 || fade > 100) return 'invalid fade duration'
  const seen = new Set<string>()
  let lastEnd = -1
  const sorted = [...decisions.regions].sort((a, b) => a.startMs - b.startMs)
  for (const r of sorted) {
    if (!r.id || seen.has(r.id)) return 'region ids must be unique'
    seen.add(r.id)
    if (r.kind === 'breath' || r.kind === 'lowspeech') continue
    const nums = [r.startMs, r.endMs, r.cutStartMs, r.cutEndMs]
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return 'region times must be finite numbers'
    if (r.startMs < 0 || r.endMs > durationMs + 500) return 'region outside the video timeline'
    if (r.endMs - r.startMs <= 0) return 'region must have positive length'
    if (r.cutStartMs < r.startMs - 5000 || r.cutEndMs > r.endMs + 5000) {
      return 'cut window too far outside detected silence'
    }
    if (r.cutEndMs - r.cutStartMs < 0 && r.action !== 'keep') {
      return 'cut window must be positive for active cuts'
    }
    if (r.action === 'compress' && r.targetMs != null && (r.targetMs < 0 || r.targetMs > 60000)) {
      return 'invalid per-region compress target'
    }
    // smart-cut regions live inside speech, may touch silence spans and each
    // other — like manual regions they are exempt from the ordering invariant
    if (r.kind !== 'manual' && !isSmartKind(r.kind) && r.startMs < lastEnd) return 'silence regions overlap'
    if (r.kind !== 'manual' && !isSmartKind(r.kind)) lastEnd = r.endMs
  }
  return null
}
