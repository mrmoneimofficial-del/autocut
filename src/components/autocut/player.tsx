'use client'

/**
 * Video player with virtual auto-cut playback:
 *  - "Original" mode plays the pristine source stream.
 *  - "Auto-cut" preview mode plays the SAME stream but skips removed spans
 *    in real time — no rendering needed, works on 4-hour sources since only
 *    the visible window is ever buffered.
 *  - Switching modes mid-playback is the before/after comparison: the same
 *    timeline position plays with and without the cuts.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStudio } from '@/lib/autocut/store'
import { usePlayhead } from '@/lib/autocut/playhead'
import { removedSpanAt, processedToOriginal, originalToProcessed } from '@/lib/autocut/geometry'
import { fmtTimecode, fmtDuration } from '@/lib/autocut/format'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Play, Pause, Volume2, VolumeX, Download, ArrowLeftRight, Scissors } from 'lucide-react'

export function Player({ className }: { className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const job = useStudio((s) => s.job)
  const streamUrl = useStudio((s) => s.streamUrl)
  const outputUrl = useStudio((s) => s.outputUrl)
  const downloadUrl = useStudio((s) => s.downloadUrl)
  const playerMode = useStudio((s) => s.playerMode)
  const setPlayerMode = useStudio((s) => s.setPlayerMode)
  const selectedRegionId = useStudio((s) => s.selectedRegionId)
  const decisions = useStudio((s) => s.decisions)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [ready, setReady] = useState(false)
  // video-element time for the transport timecode (processed time in result view)
  const [dispMs, setDispMs] = useState(0)
  const dispRef = useRef(0)

  const editingAfterRender = useStudio((s) => s.editingAfterRender)
  const isDoneView = job?.status === 'done' && !editingAfterRender
  const src = isDoneView ? outputUrl : streamUrl

  // virtual playback loop: playhead sync + skip removed spans
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const v = videoRef.current
      if (v && v.readyState >= 2) {
        const t = v.currentTime * 1000
        const st = useStudio.getState()
        const map = st.getProcessedMap()
        if (!isDoneView && st.playerMode === 'autocut' && !v.paused) {
          const span = removedSpanAt(map, t, 90)
          if (span) {
            v.currentTime = span.endMs / 1000 + 0.02
          }
        }
        // transport timecode follows the video element itself (throttled)
        if (Math.abs(t - dispRef.current) > 120) {
          dispRef.current = t
          setDispMs(t)
        }
        // the timeline playhead always uses ORIGINAL-timeline coordinates —
        // in result view the video runs on the processed timeline, so map back
        const headMs = isDoneView ? processedToOriginal(map, t) : t
        usePlayhead.getState().set(headMs, !v.paused)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isDoneView])

  // reflect play state
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [src])

  useEffect(() => {
    const v = videoRef.current
    if (v) {
      v.muted = muted
      v.volume = volume
    }
  }, [muted, volume, src])

  const toggle = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  /** Seek the video. In review mode `ms` is an ORIGINAL-timeline position
   *  (timeline clicks, cut previews). In result view the video runs on the
   *  processed timeline, so the position is converted first. */
  const seek = useCallback(
    (ms: number) => {
      const v = videoRef.current
      if (!v) return
      let targetMs = ms
      let durMs: number
      if (isDoneView) {
        const map = useStudio.getState().getProcessedMap()
        targetMs = originalToProcessed(map, ms)
        durMs = job?.outputDurationMs ?? v.duration * 1000
      } else {
        durMs = job?.meta?.durationMs ?? v.duration * 1000
      }
      v.currentTime = Math.max(0, Math.min((durMs - 100) / 1000, targetMs / 1000))
      dispRef.current = v.currentTime * 1000
      setDispMs(v.currentTime * 1000)
    },
    [isDoneView, job?.meta?.durationMs, job?.outputDurationMs]
  )

  // expose seek + toggle to parent via store-less ref bus
  useEffect(() => {
    ;(window as any).__autocutSeek = seek
    ;(window as any).__autocutToggle = toggle
  }, [seek, toggle])

  /** Preview around the selected cut: 2.5 s before → skip → 2 s after. */
  const previewCut = useCallback(() => {
    const v = videoRef.current
    if (!v || !decisions) return
    const r = decisions.regions.find((x) => x.id === selectedRegionId)
    if (!r) return
    if (useStudio.getState().playerMode !== 'autocut') setPlayerMode('autocut')
    seek(Math.max(0, r.cutStartMs - 2500))
    v.play().catch(() => {})
  }, [decisions, selectedRegionId, seek, setPlayerMode])

  const map = useStudio.getState().getProcessedMap()
  const t = dispMs
  const processedNow = Math.round(
    (() => {
      let removed = 0
      for (const s of map.removedSpans) {
        if (s.endMs <= t) removed += s.endMs - s.startMs
        else if (s.startMs < t) return s.startMs - removed
      }
      return t - removed
    })()
  )

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="relative w-full overflow-hidden rounded-lg border border-zinc-800 bg-black">
        <div className="flex aspect-video w-full items-center justify-center">
          {src ? (
            <video
              key={src}
              ref={videoRef}
              src={src}
              preload="metadata"
              playsInline
              onLoadedMetadata={() => setReady(true)}
              onError={() => setReady(false)}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-zinc-950 text-xs text-zinc-600">
              {job ? 'Media unavailable' : 'Upload a video to begin'}
            </div>
          )}
        </div>
        {!ready && src && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/70 font-mono text-[11px] text-zinc-500">
            loading stream…
          </div>
        )}
        {playerMode === 'autocut' && !isDoneView && (
          <div className="absolute left-2 top-2 rounded-sm bg-amber-500/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-black">
            AUTO-CUT PREVIEW — silence is skipped
          </div>
        )}
        {isDoneView && (
          <div className="absolute left-2 top-2 rounded-sm bg-emerald-500/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-black">
            RENDERED RESULT
          </div>
        )}
      </div>

      {/* transport */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 border-zinc-800 bg-zinc-900 p-0 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800"
          onClick={toggle}
          disabled={!src}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 border-zinc-800 bg-zinc-900 p-0 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </Button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => {
            setVolume(Number(e.target.value))
            if (muted && Number(e.target.value) > 0) setMuted(false)
          }}
          className="hidden h-1 w-20 cursor-pointer accent-amber-500 sm:block"
          aria-label="Volume"
        />
        <div className="ml-1 min-w-0 flex-1 font-mono text-[11px] leading-none text-zinc-500">
          <span className="text-zinc-300">{fmtTimecode(t)}</span>
          {!isDoneView && playerMode === 'autocut' && (
            <span className="ml-2 hidden sm:inline">
              · cut-adjusted <span className="text-amber-400">{fmtTimecode(processedNow)}</span>
            </span>
          )}
          {(() => {
            const denomMs = isDoneView ? (job?.outputDurationMs ?? null) : (job?.meta?.durationMs ?? null)
            return denomMs ? <span className="ml-2 hidden sm:inline">/ {fmtDuration(denomMs)}</span> : null
          })()}
        </div>

        <TooltipProvider delayDuration={200}>
          {!isDoneView && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800"
                    onClick={previewCut}
                    disabled={!selectedRegionId}
                  >
                    <Scissors className="mr-1 h-3 w-3" /> Test cut
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Play 2.5 s before the selected cut, skip the silence, continue after</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-8 border-zinc-800 bg-zinc-900 px-2 text-[11px] hover:border-zinc-700 hover:bg-zinc-800',
                      playerMode === 'autocut' ? 'text-amber-400' : 'text-zinc-300'
                    )}
                    onClick={() => setPlayerMode(playerMode === 'autocut' ? 'original' : 'autocut')}
                  >
                    <ArrowLeftRight className="mr-1 h-3 w-3" />
                    {playerMode === 'autocut' ? 'Auto-cut' : 'Original'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Compare: toggle skipping silences during playback</TooltipContent>
              </Tooltip>
            </>
          )}
          {isDoneView && downloadUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  className="h-8 bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-500"
                  onClick={() => window.open(downloadUrl, '_blank')}
                >
                  <Download className="mr-1 h-3 w-3" /> تحميل الفيديو المقصوص MP4
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">حمّل الفيديو النهائي بعد القص</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>
    </div>
  )
}

/** Helper for other components to seek the player. */
export function seekPlayer(ms: number) {
  ;(window as any).__autocutSeek?.(ms)
}

/** Current timeline position straight from the video element — always fresh,
 *  even while a seek is still in flight (currentTime reports the seek target
 *  immediately, unlike rAF-mirrored playhead state). */
export function currentPlayheadMs(): number {
  const v = document.querySelector('video')
  if (v && Number.isFinite(v.currentTime)) return v.currentTime * 1000
  return (window as any).__autocutPlayheadFallback?.() ?? 0
}

export default Player
