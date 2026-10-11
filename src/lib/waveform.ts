/**
 * قصّاص — غلاف الموجة الصوتية + كشف الصمت اللحظي في المتصفح
 *
 * The server extracts a tiny amplitude envelope once (GET /api/jobs/:id/wave):
 * mono 8kHz PCM → RMS per 20ms → dB, quantized to uint8 (0..90 = -dB).
 * With that in hand every slider change (threshold / gap / min-silence) is
 * re-detected client-side in ~0ms — the preview is always live — and the exact
 * resulting cut list is sent to the server for rendering, so what you see is
 * literally what gets cut.
 */

/* ------------------------------------------------------------------ types */

export type WaveStats = {
  p5: number; p10: number; p25: number; p50: number
  p75: number; p90: number; p95: number
}

export type WaveData = {
  hz: number          // samples per second (50 → one sample per 20ms)
  n: number           // sample count
  durMs: number       // n / hz
  db: Float32Array    // dB per sample (0..-90)
  stats: WaveStats | null
}

/** one silence region on the timeline (ms, original timeline) */
export type CutObj = {
  id: number
  start: number
  end: number
  pinned: boolean     // manually dragged/toggled — survives option changes
  active: boolean     // false = user excluded this gap (kept in the output)
}

/* --------------------------------------------------------------- parsing */

export function parseWave(json: unknown): WaveData | null {
  try {
    const j = json as { hz?: number; n?: number; durMs?: number; db?: string; stats?: WaveStats }
    if (!j || typeof j.db !== 'string') return null
    const hz = Number(j.hz) || 50
    const bin = Uint8Array.from(atob(j.db), (c) => c.charCodeAt(0))
    if (bin.length < 2) return null
    const db = new Float32Array(bin.length)
    for (let i = 0; i < bin.length; i++) db[i] = -bin[i]
    return {
      hz,
      n: bin.length,
      durMs: Number(j.durMs) || Math.round((bin.length / hz) * 1000),
      db,
      stats: j.stats && Number.isFinite(j.stats.p10) ? j.stats : null,
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------- instant detector */

export type DetectOpts = {
  thresholdDb: number
  gapMs: number       // silence kept around speech (split before/after)
  minSilenceMs: number // runs shorter than this are natural pauses — never cut
}

/** Detect silence cuts over the envelope. Pure + synchronous (~1ms for an hour). */
export function detectCuts(wave: WaveData, opts: DetectOpts): Array<{ start: number; end: number }> {
  const { db, hz } = wave
  const thr = opts.thresholdDb
  const msPer = 1000 / hz
  const pad = Math.max(0, opts.gapMs) / 2
  const minRun = Math.max(0, opts.minSilenceMs)
  const cuts: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < db.length) {
    if (db[i] < thr) {
      let j = i + 1
      while (j < db.length && db[j] < thr) j++
      const sMs = i * msPer
      const eMs = j * msPer
      if (eMs - sMs >= minRun) {
        const cs = Math.round(sMs + pad)
        const ce = Math.round(eMs - pad)
        if (ce - cs >= 60) cuts.push({ start: cs, end: ce })
      }
      i = j
    } else {
      i++
    }
  }
  return cuts
}

/* ------------------------------------------------------------ cut merging */

let cutIdSeq = 1
export function makeCutId(): number {
  return cutIdSeq++
}

/** auto cuts + manually pinned cuts (their exact bounds survive) → merged list */
export function buildCuts(
  auto: Array<{ start: number; end: number }>,
  pinned: CutObj[],
): CutObj[] {
  const out: CutObj[] = pinned.map((p) => ({ ...p }))
  for (const a of auto) {
    // drop auto cuts that overlap any pinned region (pinned wins)
    if (!out.some((p) => a.start < p.end - 1 && a.end > p.start + 1)) {
      out.push({ id: makeCutId(), start: a.start, end: a.end, pinned: false, active: true })
    }
  }
  out.sort((x, y) => x.start - y.start)
  return out
}

/* -------------------------------------------------- result-timeline wave */

/** envelope of the OUTPUT (source minus the active cuts) — powers the
 *  waveform while previewing the result */
export function waveWithoutCuts(wave: WaveData, cuts: CutObj[]): WaveData {
  const msPer = 1000 / wave.hz
  const active = cuts.filter((c) => c.active).sort((a, b) => a.start - b.start)
  const ranges: Array<[number, number]> = []
  let cur = 0
  for (const c of active) {
    const s = Math.round(c.start / msPer)
    const e = Math.round(c.end / msPer)
    if (s > cur) ranges.push([cur, s])
    cur = Math.max(cur, e)
  }
  if (wave.n > cur) ranges.push([cur, wave.n])
  let total = 0
  for (const [a, b] of ranges) total += b - a
  const db = new Float32Array(total)
  let off = 0
  for (const [a, b] of ranges) {
    db.set(wave.db.subarray(a, b), off)
    off += b - a
  }
  return { ...wave, n: total, durMs: Math.round(total * msPer), db }
}

/* ---------------------------------------------------- smart suggestions */

export type Suggestion = { label: string; desc: string; db: number }

/**
 * Smart threshold suggestions derived from THIS video's actual levels:
 * floor ≈ p10 (the quietest 10% of the timeline = noise/silence floor) and
 * speech ≈ p90. Chips sit at sensible points between them.
 */
export function smartSuggestions(stats: WaveStats | null): Suggestion[] {
  if (!stats) {
    return [
      { label: 'هادي', desc: 'يقص السكتة الواضحة بس — آمن على الكلام الواطي', db: -45 },
      { label: 'متوازن', desc: 'نقطة توازن تناسب أغلب الفيديوهات', db: -35 },
      { label: 'قوي', desc: 'يقص حتى الوقفات القصيرة والتنفس', db: -28 },
    ]
  }
  const floor = Math.max(-60, Math.min(-30, stats.p10))
  const speech = Math.min(-5, Math.max(floor + 6, stats.p90))
  const span = Math.max(6, speech - floor)
  const mk = (frac: number, label: string, desc: string): Suggestion => ({
    label,
    desc,
    db: Math.round(Math.max(-60, Math.min(-20, floor + span * frac))),
  })
  return [
    mk(0.18, 'هادي', `الفيديو ده أهدى مستوى فيه ${Math.round(floor)}dB — دي بتقص السكتة الواضحة بس`),
    mk(0.38, 'متوازن', `أفضل نقطة بين الضوضاء (${Math.round(floor)}dB) والكلام (${Math.round(speech)}DB) في الفيديو ده`),
    mk(0.60, 'قوي', 'بيقص كمان الوقفات القصيرة والتنفس — نتيجة أسرع بس ممكن تقص كلام واطي'),
  ]
}
