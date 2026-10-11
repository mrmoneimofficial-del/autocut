'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Waves } from 'lucide-react'
import type { CutObj, WaveData } from '@/lib/waveform'

/* ------------------------------------------------------------------ utils */

const MIN_SPAN_MS = 1500    // max zoom-in window
const MIN_CUT_MS = 30       // can't shrink a cut below this by dragging
const HANDLE_PX = 7

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function fmtClock(ms: number, fine = false): string {
  const t = Math.max(0, ms) / 1000
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const base = `${m}:${String(s).padStart(2, '0')}`
  return fine ? `${base}.${String(Math.floor((t * 100) % 100)).padStart(2, '0')}` : base
}

/* ------------------------------------------------------------- component */

export function WaveformPanel({
  wave, cuts, onCutsChange, onResetPins, durMs, videoRef, seekActive, canEdit,
}: {
  wave: WaveData | null
  cuts: CutObj[]
  onCutsChange: (c: CutObj[]) => void
  onResetPins: () => void
  durMs: number
  videoRef: React.RefObject<HTMLVideoElement | null>
  seekActive: boolean
  canEdit: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)

  const [win, setWin] = useState<[number, number]>([0, Math.max(1, durMs)])
  const winRef = useRef(win)
  useEffect(() => { winRef.current = win }, [win])
  // reset the window whenever the timeline itself changes (src ⇄ result)
  useEffect(() => { setWin([0, Math.max(1, durMs)]) }, [durMs])

  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ id: number; mode: 'start' | 'end' | 'move'; grab: number } | null>(null)
  const panRef = useRef<{ x0: number; win: [number, number]; moved: boolean } | null>(null)

  const cutsRef = useRef(cuts)
  useEffect(() => { cutsRef.current = cuts }, [cuts])
  const durRef = useRef(durMs)
  useEffect(() => { durRef.current = durMs }, [durMs])
  const canEditRef = useRef(canEdit)
  useEffect(() => { canEditRef.current = canEdit }, [canEdit])

  /* ------------------------------------------------------------- geometry */

  const xOf = useCallback((ms: number, w: number) => {
    const [t0, t1] = winRef.current
    return ((ms - t0) / (t1 - t0)) * w
  }, [])
  const msOf = useCallback((clientX: number) => {
    const el = wrapRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const [t0, t1] = winRef.current
    return t0 + ((clientX - r.left) / r.width) * (t1 - t0)
  }, [])

  const cutAt = useCallback((ms: number): CutObj | null => {
    const arr = cutsRef.current
    let lo = 0, hi = arr.length - 1
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      const c = arr[m]
      if (ms < c.start) hi = m - 1
      else if (ms >= c.end) lo = m + 1
      else return c
    }
    return null
  }, [])

  const handleAt = useCallback((ms: number): { c: CutObj; mode: 'start' | 'end' } | null => {
    const w = wrapRef.current?.clientWidth || 1
    const tol = (HANDLE_PX + 5) * ((winRef.current[1] - winRef.current[0]) / w)
    for (const c of cutsRef.current) {
      if (Math.abs(ms - c.start) <= tol) return { c, mode: 'start' }
      if (Math.abs(ms - c.end) <= tol) return { c, mode: 'end' }
    }
    return null
  }, [])

  /* ---------------------------------------------------------------- paint */

  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current
    if (!cv || !wrap) return
    const w = wrap.clientWidth, h = wrap.clientHeight
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const [t0, t1] = winRef.current
    const span = Math.max(1, t1 - t0)
    const rulerH = 20
    const waveH = h - rulerH

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    /* waveform bars — loudest sample per pixel column */
    if (wave && wave.n > 0) {
      const st = wave.stats
      const lo = Math.max(-90, (st ? st.p5 : -55) - 10)
      const hi = Math.min(0, (st ? st.p95 : -12) + 4)
      const range = Math.max(6, hi - lo)
      const mid = waveH / 2
      const maxBar = waveH / 2 - 5
      const arr = cutsRef.current
      for (let px = 0; px < w; px++) {
        const msA = t0 + (px / w) * span
        const s0 = Math.floor((msA / 1000) * wave.hz)
        if (s0 < 0 || s0 >= wave.n) continue
        const s1 = Math.min(wave.n, Math.max(s0 + 1, Math.ceil(((msA + span / w) / 1000) * wave.hz)))
        let peak = -90
        for (let i = s0; i < s1; i++) if (wave.db[i] > peak) peak = wave.db[i]
        const norm = clamp((peak - lo) / range, 0.02, 1)
        const barH = Math.max(1.5, norm * maxBar)
        // which region does this column fall in?
        const msMid = msA + span / (2 * w)
        let ci = 0
        let inCut = false, cutActive = false
        for (; ci < arr.length; ci++) {
          if (msMid < arr[ci].start) break
          if (msMid < arr[ci].end) { inCut = true; cutActive = arr[ci].active; break }
        }
        ctx.fillStyle = inCut ? (cutActive ? '#fb923c' : '#4ade80') : '#3f3f46'
        ctx.globalAlpha = inCut ? 0.8 : 0.92
        ctx.fillRect(px, mid - barH, 1, barH * 2)
      }
      ctx.globalAlpha = 1
    } else {
      // no envelope yet — subtle placeholder stripes
      ctx.strokeStyle = '#e4e4e7'
      ctx.lineWidth = 1
      for (let px = 4; px < w; px += 9) {
        ctx.beginPath()
        ctx.moveTo(px, waveH / 2 - 6)
        ctx.lineTo(px, waveH / 2 + 6)
        ctx.stroke()
      }
    }

    /* cut overlays + handles */
    const arr = cutsRef.current
    if (canEditRef.current) {
      for (const c of arr) {
        const x1 = xOf(c.start, w)
        const x2 = xOf(c.end, w)
        if (x2 < -24 || x1 > w + 24) continue
        ctx.fillStyle = c.active ? 'rgba(249,115,22,0.12)' : 'rgba(34,197,94,0.12)'
        ctx.fillRect(x1, 0, x2 - x1, waveH)
        ctx.strokeStyle = c.active ? 'rgba(249,115,22,0.85)' : 'rgba(22,163,74,0.85)'
        ctx.lineWidth = 1.5
        ctx.setLineDash(c.active ? [] : [4, 3])
        ctx.strokeRect(x1 + 0.75, 0.75, Math.max(2, x2 - x1 - 1.5), waveH - 1.5)
        ctx.setLineDash([])
        // handles
        const hc = c.active ? '#ea580c' : '#16a34a'
        for (const hx of [x1, x2]) {
          if (hx < -12 || hx > w + 12) continue
          ctx.fillStyle = hc
          ctx.beginPath()
          const hw = HANDLE_PX / 2
          ctx.roundRect(hx - hw, 3, HANDLE_PX, waveH - 6, 3)
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.moveTo(hx, waveH / 2 - 7)
          ctx.lineTo(hx, waveH / 2 - 2)
          ctx.moveTo(hx, waveH / 2 + 2)
          ctx.lineTo(hx, waveH / 2 + 7)
          ctx.stroke()
        }
      }
    }

    /* time ruler */
    ctx.fillStyle = '#fafafa'
    ctx.fillRect(0, waveH, w, rulerH)
    ctx.strokeStyle = '#e4e4e7'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, waveH + 0.5)
    ctx.lineTo(w, waveH + 0.5)
    ctx.stroke()
    const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000]
    const step = steps.find((s) => (s / span) * w >= 72) || 600000
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = '#a1a1aa'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    const first = Math.ceil(t0 / step) * step
    for (let t = first; t <= t1 + 1; t += step) {
      const x = xOf(t, w)
      if (x < -30 || x > w + 30) continue
      ctx.fillRect(x - 0.5, waveH, 1, 6)
      ctx.fillText(fmtClock(t, step < 1000), x, h - 5)
      for (let k = 1; k < 5; k++) {
        const xm = xOf(t - (step * k) / 5, w)
        if (xm > 0 && xm < w) ctx.fillRect(xm - 0.5, waveH, 1, 3)
      }
    }
  }, [wave, xOf])

  useEffect(() => { draw() }, [draw, cuts, win, hover, canEdit])
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [draw])

  /* ------------------------------------------------------------ playhead */

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const v = videoRef.current, ph = playheadRef.current, wrap = wrapRef.current
      if (v && ph && wrap && durRef.current > 0 && isFinite(v.currentTime)) {
        const [t0, t1] = winRef.current
        const ms = v.currentTime * 1000
        const x = ((ms - t0) / (t1 - t0)) * wrap.clientWidth
        if (ms >= t0 - 250 && ms <= t1 + 250 && x >= -2 && x <= wrap.clientWidth + 2) {
          ph.style.left = `${x}px`
          ph.style.display = 'block'
        } else {
          ph.style.display = 'none'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoRef])

  /* ------------------------------------------------------------- zooming */

  const zoomAt = useCallback((frac: number, factor: number) => {
    setWin(([t0, t1]) => {
      const dur = Math.max(1, durRef.current)
      const span = t1 - t0
      const minSpan = Math.min(MIN_SPAN_MS, dur)
      const ns = clamp(span * factor, minSpan, dur)
      const anchor = t0 + span * frac
      const nt0 = clamp(anchor - ns * frac, 0, Math.max(0, dur - ns))
      return [nt0, nt0 + ns]
    })
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!wave) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1)
      zoomAt(frac, e.deltaY < 0 ? 0.72 : 1.4)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wave, zoomAt])

  /* ----------------------------------------------------------- pointers */

  const commitCuts = useCallback((next: CutObj[]) => {
    cutsRef.current = next // draw reads the ref — instant feedback even mid-drag
    onCutsChange(next)
  }, [onCutsChange])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const ms = msOf(e.clientX)
    wrapRef.current?.setPointerCapture(e.pointerId)
    if (canEditRef.current) {
      const h = handleAt(ms)
      if (h) {
        dragRef.current = { id: h.c.id, mode: h.mode, grab: 0 }
        setDragging(true)
        e.preventDefault()
        return
      }
      const c = cutAt(ms)
      if (c) {
        dragRef.current = { id: c.id, mode: 'move', grab: ms - c.start }
        setDragging(true)
        e.preventDefault()
        return
      }
    }
    panRef.current = { x0: e.clientX, win: [...winRef.current] as [number, number], moved: false }
  }, [msOf, handleAt, cutAt])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setHover({ x: clamp(e.clientX - r.left, 0, r.width), ms: msOf(e.clientX) })
    }
    const ms = msOf(e.clientX)
    const d = dragRef.current
    if (d) {
      const arr = cutsRef.current
      const idx = arr.findIndex((c) => c.id === d.id)
      if (idx < 0) return
      const cut = arr[idx]
      const loBound = idx > 0 ? arr[idx - 1].end : 0
      const hiBound = idx < arr.length - 1 ? arr[idx + 1].start : durRef.current
      let { start, end } = cut
      if (d.mode === 'start') {
        start = clamp(ms, loBound, end - MIN_CUT_MS)
      } else if (d.mode === 'end') {
        end = clamp(ms, start + MIN_CUT_MS, hiBound)
      } else {
        const len = end - start
        const ns = clamp(ms - d.grab, loBound, hiBound - len)
        start = ns
        end = ns + len
      }
      const next = arr.map((c) => (c.id === d.id ? { ...cut, start, end, pinned: true } : c))
      commitCuts(next)
      return
    }
    const p = panRef.current
    if (p) {
      const dx = e.clientX - p.x0
      if (Math.abs(dx) > 3) p.moved = true
      if (p.moved) {
        const el2 = wrapRef.current
        const w = el2?.clientWidth || 1
        const [pt0, pt1] = p.win
        const dur = Math.max(1, durRef.current)
        const span = pt1 - pt0
        const dMs = (dx / w) * span
        const nt0 = clamp(pt0 - dMs, 0, Math.max(0, dur - span))
        setWin([nt0, nt0 + span])
      }
      return
    }
    // hover cursor
    if (el) {
      const h = canEditRef.current ? handleAt(ms) : null
      if (h) el.style.cursor = 'col-resize'
      else if (canEditRef.current && cutAt(ms)) el.style.cursor = 'grab'
      else el.style.cursor = seekActive ? 'pointer' : 'default'
    }
  }, [msOf, handleAt, cutAt, commitCuts, seekActive])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    const p = panRef.current
    panRef.current = null
    if (!d && p && !p.moved && seekActive) {
      const v = videoRef.current
      if (v) v.currentTime = msOf(e.clientX) / 1000
    }
  }, [msOf, seekActive, videoRef])

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!canEditRef.current) return
    const c = cutAt(msOf(e.clientX))
    if (c) {
      commitCuts(cutsRef.current.map((x) => (x.id === c.id ? { ...x, active: !x.active, pinned: true } : x)))
    }
  }, [msOf, cutAt, commitCuts])

  /* -------------------------------------------------------------- render */

  const hasPins = cuts.some((c) => c.pinned)
  const zoomed = win[1] - win[0] < durMs - 1
  const dragCut = dragging ? cuts.find((c) => c.id === dragRef.current?.id) : null

  return (
    <div className="space-y-1.5 select-none">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <IconBtn title="تصغير" onClick={() => zoomAt(0.5, 1.7)}><ZoomOut className="w-4 h-4" /></IconBtn>
          <IconBtn title="تكبير" onClick={() => zoomAt(0.5, 0.6)}><ZoomIn className="w-4 h-4" /></IconBtn>
          <IconBtn title="عرض الفيديو كله" active={zoomed} onClick={() => setWin([0, Math.max(1, durMs)])}>
            <Maximize2 className="w-4 h-4" />
          </IconBtn>
          <span className="text-[11px] text-zinc-400 tabular-nums font-semibold ms-1 whitespace-nowrap" dir="ltr">
            {fmtClock(win[0], true)} → {fmtClock(win[1], true)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-[11px] text-zinc-400">اسحب الحواف للتعديل · دبل كليك لاستثناء فجوة · العجلة للزووم</span>
          {hasPins && canEdit && (
            <button
              onClick={onResetPins}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 h-8 text-xs font-bold text-zinc-600 hover:border-orange-300 hover:text-orange-600 transition"
            >
              <RotateCcw className="w-3.5 h-3.5" /> رجّع تعديلاتك
            </button>
          )}
        </div>
      </div>

      <div
        ref={wrapRef}
        dir="ltr"
        className={`relative h-40 sm:h-48 rounded-xl border border-zinc-200 bg-white overflow-hidden touch-none ${dragging ? 'cursor-grabbing!' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="الموجة الصوتية وفجوات الصمت"
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        <div ref={playheadRef} className="absolute top-0 bottom-0 w-[2px] bg-zinc-900 rounded-full hidden pointer-events-none" />
        {(hover || dragCut) && (
          <div
            className="absolute top-1.5 px-2 py-1 rounded-lg bg-zinc-900/85 text-white text-[11px] font-bold tabular-nums pointer-events-none whitespace-nowrap"
            style={{
              left: `clamp(4px, calc(${clamp(hover?.x ?? 0, 0, (wrapRef.current?.clientWidth ?? 300))}px - 55%), calc(100% - 150px))`,
            }}
          >
            {dragCut
              ? `الفجوة: ${((dragCut.end - dragCut.start) / 1000).toFixed(2)}ث · ${fmtClock(dragCut.start, true)} ← ${fmtClock(dragCut.end, true)}`
              : fmtClock(hover!.ms, true)}
          </div>
        )}
        {canEdit && cuts.length === 0 && (
          <div className="absolute inset-x-0 top-2 flex justify-center pointer-events-none">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100/90 border border-zinc-200 px-3 py-1 text-[11px] font-bold text-zinc-500">
              <Waves className="w-3.5 h-3.5" /> مفيش فجوات بالحساسية دي — جرّب تديل السلايدر
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-400 px-1" dir="rtl">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-zinc-500 inline-block" /> كلام</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-orange-400 inline-block" /> صمت هيتشال</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-green-400 inline-block" /> مستثنى</span>
        </span>
        {canEdit && <span className="hidden sm:inline">اكتب المونتاج: كبّر، اسحب بداية أو نهاية أي فجوة، واستثني اللي مش عايز تقصه</span>}
      </div>
    </div>
  )
}

function IconBtn({ title, onClick, active, children }: {
  title: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`grid place-items-center w-8 h-8 rounded-lg border transition ${active ? 'border-orange-500 bg-orange-50 text-orange-600' : 'border-zinc-200 bg-white text-zinc-600 hover:border-orange-300 hover:text-orange-600'}`}
    >
      {children}
    </button>
  )
}
