'use client'

/**
 * Professional detection-review timeline:
 *  - Multi-level waveform (envelope buckets fetched per zoom window)
 *  - Detected regions overlaid & color-coded by action
 *  - Draggable cut-window edges (amber grip handles) on every non-keep region
 *  - Thumbnail filmstrip along the top (appears once the worker finishes it)
 *  - Zoom (wheel/pinch/buttons) + pan (drag) across the whole video
 *  - Frame-accurate playhead rendered via requestAnimationFrame
 *  - Click/drag to seek; region click selects it
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '@/lib/autocut/store'
import { usePlayhead } from '@/lib/autocut/playhead'
import { api } from '@/lib/autocut/api'
import { regionAt } from '@/lib/autocut/geometry'
import type { EnvelopeBuckets } from '@/lib/autocut/types'
import { fmtTimecode } from '@/lib/autocut/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight } from 'lucide-react'

const DB_FLOOR = -60
const DB_CEIL = 0

/** Filmstrip band height (drawn at the very top once thumbnails are ready). */
const STRIP_H = 34
/** Pointer distance (CSS px) at which a cut edge is grabbable. */
const EDGE_GRAB_PX = 7
/** Minimum on-screen cut width (px) for the grip handles to appear. */
const HANDLE_MIN_W = 10

/** Thumbnail filmstrip manifest polled from the worker until `ready`. */
interface ThumbsMeta {
  ready: boolean
  generating: boolean
  count: number
  intervalMs: number
  urlTemplate: string
}

/** Active pointer drag: timeline pan, or a region cut-edge resize. */
type DragMode =
  | { kind: 'pan'; x: number; startMs: number }
  | { kind: 'edge'; regionId: string; edge: 'start' | 'end' }

function colorFor(action: string, kind: string): { fill: string; stroke: string } {
  if (kind === 'breath') return { fill: 'rgba(13,148,136,0.30)', stroke: 'rgba(13,148,136,0.8)' }
  if (kind === 'lowspeech') return { fill: 'rgba(139,92,246,0.30)', stroke: 'rgba(139,92,246,0.8)' }
  if (kind === 'filler') return { fill: 'rgba(251,146,60,0.32)', stroke: 'rgba(251,146,60,0.9)' }
  if (kind === 'repetition') return { fill: 'rgba(244,63,94,0.30)', stroke: 'rgba(244,63,94,0.85)' }
  if (kind === 'mistake') return { fill: 'rgba(190,24,93,0.30)', stroke: 'rgba(190,24,93,0.85)' }
  if (kind === 'offtopic') return { fill: 'rgba(100,116,139,0.35)', stroke: 'rgba(100,116,139,0.9)' }
  if (action === 'remove') return { fill: 'rgba(248,113,113,0.28)', stroke: 'rgba(248,113,113,0.85)' }
  if (action === 'compress') return { fill: 'rgba(251,146,60,0.28)', stroke: 'rgba(251,146,60,0.85)' }
  return { fill: 'rgba(52,211,153,0.22)', stroke: 'rgba(52,211,153,0.7)' }
}

interface Props {
  onSeek?: (ms: number) => void
  height?: number
}

export function TimelineCanvas({ onSeek, height = 148 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const jobId = useStudio((s) => s.job?.id ?? null)
  const durationMs = useStudio((s) => s.job?.meta?.durationMs ?? 0)
  const decisions = useStudio((s) => s.decisions)
  const selectedRegionId = useStudio((s) => s.selectedRegionId)
  const playerMode = useStudio((s) => s.playerMode)
  const selectRegion = useStudio((s) => s.selectRegion)
  const markInMs = useStudio((s) => s.markInMs)
  const markOutMs = useStudio((s) => s.markOutMs)

  // viewport state: null = auto-fit to the whole video
  const [view, setView] = useState<{ startMs: number; endMs: number } | null>(null)
  const [buckets, setBuckets] = useState<EnvelopeBuckets | null>(null)
  const [dragMode, setDragMode] = useState<DragMode | null>(null)

  // thumbnail filmstrip manifest (ref mirrors state for non-reactive readers)
  const [thumbs, setThumbs] = useState<ThumbsMeta | null>(null)
  const thumbsRef = useRef<ThumbsMeta | null>(null)
  /** thumb index → image element (loaded or in flight). */
  const imgs = useRef<Map<number, HTMLImageElement>>(new Map())
  const [thumbTick, setThumbTick] = useState(0)

  // drop stale thumbnail state when the job changes (same render-adjust
  // pattern as prevDuration / prevSelected — sanctioned derived-state reset;
  // the ref-held images are cleared inside the thumbs effect below)
  const [prevThumbJob, setPrevThumbJob] = useState(jobId)
  if (jobId !== prevThumbJob) {
    setPrevThumbJob(jobId)
    setThumbs(null)
  }

  const viewWindow = useMemo(() => {
    if (!durationMs) return { startMs: 0, endMs: 0 }
    if (!view) return { startMs: 0, endMs: durationMs }
    const s = Math.max(0, Math.min(view.startMs, durationMs))
    const e = Math.max(s + Math.min(1000, durationMs), Math.min(view.endMs, durationMs))
    return { startMs: s, endMs: e }
  }, [view, durationMs])

  // keep the viewport inside the timeline when the video changes (adjust
  // during render — React's sanctioned pattern for derived state)
  const [prevDuration, setPrevDuration] = useState(durationMs)
  if (durationMs !== prevDuration) {
    setPrevDuration(durationMs)
    setView(null)
  }

  // jump to the selected region (same render-adjust pattern)
  const [prevSelected, setPrevSelected] = useState<string | null>(null)
  if (selectedRegionId !== prevSelected) {
    setPrevSelected(selectedRegionId)
    if (selectedRegionId && decisions) {
      const r = decisions.regions.find((x) => x.id === selectedRegionId)
      const span = viewWindow.endMs - viewWindow.startMs
      if (r && span > 0 && (r.startMs < viewWindow.startMs + span * 0.05 || r.endMs > viewWindow.endMs - span * 0.05)) {
        const mid = (r.startMs + r.endMs) / 2
        const s = Math.max(0, Math.min(durationMs - span, mid - span / 2))
        setView({ startMs: s, endMs: s + span })
      }
    }
  }

  // derived loading indicator — no effect setState needed
  const loadingEnv = !!buckets && (buckets.startMs !== viewWindow.startMs || buckets.endMs !== viewWindow.endMs)

  // container resize
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 1000
      setWidth(Math.max(200, w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // fetch envelope for the current window (async-only state updates)
  useEffect(() => {
    let canceled = false
    const jobId = useStudio.getState().job?.id
    if (!jobId || durationMs <= 0) return
    const span = viewWindow.endMs - viewWindow.startMs
    if (span <= 0) return
    const px = Math.max(120, Math.min(6000, Math.floor(width)))
    api
      .envelope(jobId, viewWindow.startMs, viewWindow.endMs, px)
      .then((b) => {
        if (!canceled) setBuckets(b)
      })
      .catch(() => {
        if (!canceled) setBuckets(null)
      })
    return () => {
      canceled = true
    }
  }, [viewWindow.startMs, viewWindow.endMs, width, durationMs])

  // stable redraw trigger for thumbnails that finish loading asynchronously
  const redraw = useCallback(() => setThumbTick((v) => v + 1), [])

  // thumbnail manifest: fetch on mount / job change; the first request also
  // kicks off server-side generation, then we poll every 4s until ready
  useEffect(() => {
    imgs.current.clear()
    thumbsRef.current = null
    if (!jobId) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const meta = await api.thumbsMeta(jobId)
        if (disposed) return
        const m: ThumbsMeta = {
          ready: meta.ready,
          generating: meta.generating,
          count: meta.count,
          intervalMs: meta.intervalMs,
          urlTemplate: meta.urlTemplate,
        }
        thumbsRef.current = m
        setThumbs(m)
        if (!m.ready && m.generating) timer = setTimeout(poll, 4000)
      } catch {
        /* thumbnails unavailable — the timeline stays waveform-only */
      }
    }
    poll()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId])

  // ---------------------------------------------------------------- draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || width < 10 || durationMs <= 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    // vertical layout: [filmstrip] gap [ruler] gap [waveform] — the strip
    // takes over the top 36px once thumbnails are ready (canvas height fixed)
    const stripOn = !!(thumbs && thumbs.ready && thumbs.count > 0 && thumbs.intervalMs > 0)
    const stripH = stripOn ? STRIP_H : 0
    const rulerH = 20
    const rulerY = stripOn ? STRIP_H + 2 : 0
    const waveTop = rulerY + rulerH + 4
    const waveH = height - rulerY - rulerH - 8
    const mid = waveTop + waveH / 2
    const { startMs, endMs } = viewWindow
    const spanMs = Math.max(1, endMs - startMs)
    const xOf = (ms: number) => ((ms - startMs) / spanMs) * width
    const msOf = (x: number) => startMs + (x / width) * spanMs

    // background
    ctx.fillStyle = '#0a0a0b'
    ctx.fillRect(0, 0, width, height)

    // ---- thumbnail filmstrip (top band)
    if (stripOn && thumbs) {
      const t = thumbs
      ctx.fillStyle = '#0a0a0b'
      ctx.fillRect(0, 0, width, stripH)
      let inFlight = 0
      for (const im of imgs.current.values()) if (!im.complete) inFlight++
      const iMin = Math.max(0, Math.floor(startMs / t.intervalMs))
      const iMax = Math.min(t.count - 1, Math.ceil(endMs / t.intervalMs) - 1)
      for (let i = iMin; i <= iMax; i++) {
        let img = imgs.current.get(i)
        if (!img) {
          // kick off a capped set of in-flight loads (bg shows through until done)
          if (inFlight >= 40) continue
          img = new Image()
          img.onload = () => redraw()
          img.src = t.urlTemplate.replace('{i}', String(i))
          imgs.current.set(i, img)
          inFlight++
          continue
        }
        if (!img.complete || img.naturalWidth <= 0) continue
        const cx = xOf(i * t.intervalMs)
        const cw = Math.max(2, xOf((i + 1) * t.intervalMs) - cx - 1) // 1px gap
        // aspect-fill ("cover") crop: thumbs are 160px wide, height varies
        const cellAR = cw / stripH
        const srcAR = img.naturalWidth / img.naturalHeight
        let sw = img.naturalWidth
        let sh = img.naturalHeight
        let sx = 0
        let sy = 0
        if (srcAR > cellAR) {
          sw = img.naturalHeight * cellAR
          sx = (img.naturalWidth - sw) / 2
        } else {
          sh = img.naturalWidth / cellAR
          sy = (img.naturalHeight - sh) / 2
        }
        ctx.drawImage(img, sx, sy, sw, sh, cx, 0, cw, stripH)
      }
      // dim the strip across removed (cut) time ranges
      if (decisions) {
        ctx.fillStyle = 'rgba(24,24,27,0.55)'
        for (const r of decisions.regions) {
          if (r.action !== 'remove') continue
          if (r.cutEndMs < startMs || r.cutStartMs > endMs) continue
          const x1 = Math.max(0, xOf(r.cutStartMs))
          const x2 = Math.min(width, xOf(r.cutEndMs))
          if (x2 - x1 > 0.5) ctx.fillRect(x1, 0, x2 - x1, stripH)
        }
      }
      // bottom rule, mirroring the ruler's
      ctx.strokeStyle = 'rgba(63,63,70,0.8)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, stripH + 0.5)
      ctx.lineTo(width, stripH + 0.5)
      ctx.stroke()
    }

    // ---- regions under waveform
    if (decisions) {
      for (const r of decisions.regions) {
        if (r.endMs < startMs || r.startMs > endMs) continue
        const x1 = Math.max(-4, xOf(r.startMs))
        const x2 = Math.min(width + 4, xOf(r.endMs))
        if (x2 - x1 < 0.5) continue
        const c = colorFor(r.action, r.kind)
        ctx.fillStyle = c.fill
        ctx.fillRect(x1, waveTop, x2 - x1, waveH)
        if (selectedRegionId === r.id) {
          ctx.strokeStyle = '#fbbf24'
          ctx.lineWidth = 1.5
          ctx.strokeRect(x1 + 0.75, waveTop + 0.75, x2 - x1 - 1.5, waveH - 1.5)
        } else {
          ctx.strokeStyle = c.stroke
          ctx.lineWidth = 0.75
          ctx.strokeRect(x1 + 0.5, waveTop + 0.5, x2 - x1 - 1, waveH - 1)
        }
        // hatch removed windows
        if (r.action !== 'keep' && r.kind === 'silence') {
          const cx1 = Math.max(xOf(r.cutStartMs), x1)
          const cx2 = Math.min(xOf(r.cutEndMs), x2)
          if (cx2 - cx1 > 1) {
            ctx.save()
            ctx.beginPath()
            ctx.rect(cx1, waveTop, cx2 - cx1, waveH)
            ctx.clip()
            ctx.strokeStyle = 'rgba(248,113,113,0.45)'
            ctx.lineWidth = 1
            ctx.beginPath()
            for (let x = cx1 - waveH; x < cx2 + waveH; x += 7) {
              ctx.moveTo(x, waveTop + waveH)
              ctx.lineTo(x + waveH, waveTop)
            }
            ctx.stroke()
            ctx.restore()
          }
        }
      }
    }

    // ---- waveform from buckets
    if (buckets && buckets.min.length > 0) {
      const n = buckets.min.length
      const yOf = (db: number) => {
        const c = Math.max(DB_FLOOR, Math.min(DB_CEIL, db))
        return mid - ((c - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * (waveH / 2)
      }
      const gradient = ctx.createLinearGradient(0, waveTop, 0, waveTop + waveH)
      gradient.addColorStop(0, 'rgba(161,161,170,0.9)')
      gradient.addColorStop(0.5, 'rgba(228,228,231,0.95)')
      gradient.addColorStop(1, 'rgba(161,161,170,0.9)')
      ctx.fillStyle = gradient
      for (let i = 0; i < n; i++) {
        const x = (i / n) * width
        const w = Math.max(1, width / n + 0.5)
        // yOf maps LOUDER dB to a SMALLER y (higher on screen): buckets.max is
        // the top of the bar, buckets.min the bottom. Height = bottom - top.
        const yTop = yOf(buckets.max[i])
        const yBottom = yOf(buckets.min[i])
        ctx.fillRect(x, yTop, w, Math.max(1.2, yBottom - yTop))
      }
      // center line
      ctx.strokeStyle = 'rgba(113,113,122,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(width, mid)
      ctx.stroke()
    } else if (loadingEnv) {
      ctx.fillStyle = 'rgba(113,113,122,0.4)'
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillText('loading waveform…', 8, mid)
    } else {
      ctx.fillStyle = 'rgba(113,113,122,0.4)'
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillText('waveform available after analysis', 8, mid)
    }

    // ---- draggable cut-edge grip handles (above fills + waveform)
    if (decisions) {
      for (const r of decisions.regions) {
        if (r.action === 'keep') continue
        if (r.endMs < startMs || r.startMs > endMs) continue
        const esX = xOf(r.cutStartMs)
        const eeX = xOf(r.cutEndMs)
        if (eeX - esX <= HANDLE_MIN_W) continue
        ctx.fillStyle = selectedRegionId === r.id ? 'rgba(251,191,36,0.9)' : 'rgba(217,119,6,0.7)'
        for (const ex of [esX, eeX]) {
          // 2px vertical rail across the whole region band
          ctx.fillRect(ex - 1, waveTop, 2, waveH)
          // 5×12 rounded grip centred on the rail
          const gy = waveTop + waveH / 2 - 6
          ctx.beginPath()
          if (typeof ctx.roundRect === 'function') ctx.roundRect(ex - 2.5, gy, 5, 12, 2)
          else ctx.rect(ex - 2.5, gy, 5, 12)
          ctx.fill()
        }
      }
    }

    // ---- ruler with adaptive ticks
    ctx.fillStyle = '#18181b'
    ctx.fillRect(0, rulerY, width, rulerH)
    ctx.strokeStyle = 'rgba(63,63,70,0.8)'
    ctx.beginPath()
    ctx.moveTo(0, rulerY + rulerH - 0.5)
    ctx.lineTo(width, rulerY + rulerH - 0.5)
    ctx.stroke()
    const targetTicks = Math.max(4, Math.floor(width / 110))
    const rawStep = spanMs / targetTicks
    const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000]
    const step = steps.find((s) => s >= rawStep) ?? 3600000
    ctx.fillStyle = '#71717a'
    ctx.font = '10px ui-monospace, monospace'
    ctx.textBaseline = 'middle'
    const first = Math.ceil(startMs / step) * step
    for (let t = first; t <= endMs; t += step) {
      const x = xOf(t)
      ctx.strokeStyle = 'rgba(82,82,91,0.9)'
      ctx.beginPath()
      ctx.moveTo(x, rulerY + rulerH - 6)
      ctx.lineTo(x, rulerY + rulerH - 1)
      ctx.stroke()
      ctx.fillStyle = '#71717a'
      const label = fmtTimecode(t).slice(0, step < 1000 ? 12 : step < 60000 ? 8 : 5)
      ctx.fillText(label, x + 3, rulerY + rulerH / 2 - 1)
    }
    // subtle hint while the worker is still extracting thumbnails
    if (thumbs && !thumbs.ready && thumbs.generating) {
      ctx.fillStyle = '#52525b'
      ctx.font = '10px system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText('جاري توليد الصور المصغرة…', width - 8, rulerY + rulerH / 2 - 1)
      ctx.textAlign = 'left'
    }

    // ---- manual montage marks (IN/OUT + selection range)
    const drawMark = (ms: number, label: string) => {
      if (ms < startMs - 100 || ms > endMs + 100) return
      const x = xOf(Math.max(startMs, Math.min(endMs, ms)))
      ctx.strokeStyle = '#fbbf24'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(x, 2)
      ctx.lineTo(x, height - 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#fbbf24'
      const tw = ctx.measureText(label).width + 8
      ctx.fillRect(x - tw / 2, rulerY + rulerH + 2, tw, 14)
      ctx.fillStyle = '#000'
      ctx.font = 'bold 9px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(label, x, rulerY + rulerH + 12)
      ctx.textAlign = 'left'
    }
    if (markInMs != null && markOutMs != null && markOutMs > markInMs) {
      const x1 = xOf(Math.max(startMs, markInMs))
      const x2 = xOf(Math.min(endMs, markOutMs))
      if (x2 > x1) {
        ctx.fillStyle = 'rgba(251,191,36,0.14)'
        ctx.fillRect(x1, waveTop, x2 - x1, waveH)
      }
    }
    if (markInMs != null) drawMark(markInMs, 'IN')
    if (markOutMs != null) drawMark(markOutMs, 'OUT')

    // ---- playhead
    const phMs = usePlayhead.getState().ms
    if (phMs >= startMs && phMs <= endMs) {
      const x = xOf(phMs)
      ctx.strokeStyle = '#fbbf24'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 2)
      ctx.lineTo(x, height - 2)
      ctx.stroke()
      ctx.fillStyle = '#fbbf24'
      ctx.beginPath()
      ctx.moveTo(x - 4, 0)
      ctx.lineTo(x + 4, 0)
      ctx.lineTo(x, 7)
      ctx.closePath()
      ctx.fill()
    }
  }, [width, height, viewWindow, buckets, decisions, selectedRegionId, loadingEnv, durationMs, markInMs, markOutMs, thumbs, thumbTick, redraw])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    let raf = 0
    let last = -1
    const loop = () => {
      const ph = usePlayhead.getState()
      if (ph.ms !== last) {
        last = ph.ms
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  // ---------------------------------------------------------------- zoom
  const zoomAt = useCallback(
    (factor: number, anchorX: number) => {
      setView((v) => {
        if (!v || durationMs <= 0) return v
        const span = v.endMs - v.startMs
        const anchorMs = v.startMs + (anchorX / width) * span
        let newSpan = Math.max(2000, Math.min(durationMs, span * factor))
        let s = anchorMs - (anchorMs - v.startMs) * (newSpan / span)
        s = Math.max(0, Math.min(durationMs - newSpan, s))
        return { startMs: s, endMs: s + newSpan }
      })
    },
    [width, durationMs]
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const x = e.clientX - rect.left
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        zoomAt(e.deltaY > 0 ? 1.25 : 0.8, x)
      } else {
        // pan horizontally
        setView((v) => {
          if (!v) return v
          const span = v.endMs - v.startMs
          const d = (e.deltaX / width) * span
          const s = Math.max(0, Math.min(durationMs - span, v.startMs + d))
          return { startMs: s, endMs: s + span }
        })
      }
    },
    [zoomAt, width, durationMs]
  )

  // pointer interactions: seek / select / pan / cut-edge drag
  const hitCutEdge = useCallback(
    (x: number): { regionId: string; edge: 'start' | 'end' } | null => {
      if (!decisions) return null
      const { startMs, endMs } = viewWindow
      const span = Math.max(1, endMs - startMs)
      let best: { regionId: string; edge: 'start' | 'end'; d: number } | null = null
      for (const r of decisions.regions) {
        if (r.action === 'keep') continue
        if (r.endMs < startMs || r.startMs > endMs) continue
        const ds = Math.abs(x - ((r.cutStartMs - startMs) / span) * width)
        const de = Math.abs(x - ((r.cutEndMs - startMs) / span) * width)
        if (ds <= EDGE_GRAB_PX && (!best || ds < best.d)) best = { regionId: r.id, edge: 'start', d: ds }
        if (de <= EDGE_GRAB_PX && (!best || de < best.d)) best = { regionId: r.id, edge: 'end', d: de }
      }
      return best ? { regionId: best.regionId, edge: best.edge } : null
    },
    [decisions, viewWindow, width]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const x = e.clientX - rect.left
      const span = viewWindow.endMs - viewWindow.startMs
      const ms = viewWindow.startMs + (x / width) * span
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* pointer already released / synthetic — drag still works via move+up */
      }
      // 1) grabbing a cut edge wins over pan & seek
      const hit = hitCutEdge(x)
      if (hit) {
        selectRegion(hit.regionId)
        setDragMode({ kind: 'edge', regionId: hit.regionId, edge: hit.edge })
        const canvas = canvasRef.current
        if (canvas) canvas.style.cursor = 'col-resize'
        return
      }
      // 2) explicit pan (shift / middle button)
      if (e.shiftKey || e.button === 1) {
        setDragMode({ kind: 'pan', x, startMs: viewWindow.startMs })
        return
      }
      // 3) seek (+ region click-select)
      const reg = decisions ? regionAt(decisions.regions, ms) : null
      if (reg && reg.kind === 'silence') selectRegion(reg.id)
      onSeek?.(ms)
    },
    [width, viewWindow, decisions, selectRegion, onSeek, hitCutEdge]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const x = e.clientX - rect.left
      // edge drag: patch the cut window live (undo history coalesces per region)
      if (dragMode && dragMode.kind === 'edge') {
        const st = useStudio.getState()
        const r = st.decisions?.regions.find((z) => z.id === dragMode.regionId)
        if (!r) return
        const span = viewWindow.endMs - viewWindow.startMs
        const ms = viewWindow.startMs + (x / width) * span
        if (dragMode.edge === 'start') {
          const v = Math.max(0, Math.min(ms, r.cutEndMs - 20))
          // manual regions: the span IS the cut — keep them identical
          if (r.kind === 'manual') st.patchRegion(r.id, { cutStartMs: v, startMs: v })
          else st.patchRegion(r.id, { cutStartMs: v })
        } else {
          const v = Math.min(durationMs, Math.max(ms, r.cutStartMs + 20))
          if (r.kind === 'manual') st.patchRegion(r.id, { cutEndMs: v, endMs: v })
          else st.patchRegion(r.id, { cutEndMs: v })
        }
        return
      }
      // pan drag
      if (dragMode && dragMode.kind === 'pan') {
        const span = viewWindow.endMs - viewWindow.startMs
        const d = ((dragMode.x - x) / width) * span
        setView((v) => {
          if (!v) return v
          const s = Math.max(0, Math.min(durationMs - span, dragMode.startMs + d))
          return { startMs: s, endMs: s + span }
        })
        return
      }
      // hover: col-resize over a grabbable cut edge
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = hitCutEdge(x) ? 'col-resize' : ''
    },
    [dragMode, width, viewWindow, durationMs, hitCutEdge]
  )

  const onPointerUp = useCallback(() => {
    setDragMode(null)
    const canvas = canvasRef.current
    if (canvas) canvas.style.cursor = ''
  }, [])

  const zoomPct = durationMs > 0 ? Math.round((durationMs / Math.max(1, viewWindow.endMs - viewWindow.startMs)) * 100) / 100 : 1
  const jumpCut = useCallback(
    (dir: 1 | -1) => {
      const map = useStudio.getState().getProcessedMap()
      const ph = usePlayhead.getState().ms
      const target = dir === 1 ? nextCut(map, ph) : prevCut(map, ph)
      if (target != null) onSeek?.(target)
    },
    [onSeek]
  )

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100" onClick={() => zoomAt(0.7, width / 2)}>
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Zoom out</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100" onClick={() => zoomAt(1.4, width / 2)}>
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Zoom in</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100" onClick={() => setView({ startMs: 0, endMs: durationMs })} disabled={zoomPct === 1}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Fit whole video</TooltipContent>
            </Tooltip>
            <span className="ml-1 font-mono text-[10px] text-zinc-600">{zoomPct.toFixed(1)}×</span>
          </TooltipProvider>
        </div>
        <div className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-zinc-500">
          <span className="hidden sm:inline">{fmtTimecode(viewWindow.startMs)}</span>
          <span className="text-zinc-700">→</span>
          <span className="hidden sm:inline">{fmtTimecode(viewWindow.endMs)}</span>
          {playerMode === 'autocut' && <span className="ml-2 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-amber-400">AUTO-CUT PREVIEW</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100" onClick={() => jumpCut(-1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100" onClick={() => jumpCut(1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={wrapRef}
        className={cn(
          'relative w-full cursor-crosshair overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 select-none',
          dragMode?.kind === 'pan' && 'cursor-grabbing'
        )}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="block" style={{ height }} aria-label="Video timeline with waveform and detected cuts" role="img" />
        {loadingEnv && (
          <div
            className={cn(
              'pointer-events-none absolute right-2 rounded bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500',
              thumbs?.ready ? 'top-[60px]' : 'top-6'
            )}
          >
            …
          </div>
        )}
      </div>
      <div className="sm:hidden">
        <Slider
          value={[Math.round(((viewWindow.startMs + (viewWindow.endMs - viewWindow.startMs) / 2) / Math.max(1, durationMs)) * 100)]}
          min={0}
          max={100}
          step={1}
          onValueChange={(v) => {
            const span = viewWindow.endMs - viewWindow.startMs
            const mid = (v[0] / 100) * durationMs
            const s = Math.max(0, Math.min(durationMs - span, mid - span / 2))
            setView({ startMs: s, endMs: s + span })
          }}
          className="py-1"
        />
        <div className="flex justify-between font-mono text-[9px] text-zinc-600">
          <span>{fmtTimecode(viewWindow.startMs)}</span>
          <span>{fmtTimecode(viewWindow.endMs)}</span>
        </div>
      </div>
    </div>
  )
}

function nextCut(map: { removedSpans: Array<{ startMs: number; endMs }> }, tMs: number): number | null {
  for (const s of map.removedSpans) if (s.startMs > tMs + 50) return s.startMs
  return null
}
function prevCut(map: { removedSpans: Array<{ startMs: number; endMs }> }, tMs: number): number | null {
  let found: number | null = null
  for (const s of map.removedSpans) {
    if (s.startMs < tMs - 50) found = s.startMs
    else break
  }
  return found
}

export default TimelineCanvas
