'use client'

/**
 * Manual montage toolbar — mark in/out on any unwanted part and cut it.
 * Professional editor flow with keyboard shortcuts:
 *   I = mark in · O = mark out · A/Enter = cut · Esc = clear marks
 *   Space = play/pause · Delete = remove the selected cut
 */

import { useStudio } from '@/lib/autocut/store'
import { usePlayhead } from '@/lib/autocut/playhead'
import { currentPlayheadMs } from '@/components/autocut/player'
import { fmtTimecode } from '@/lib/autocut/format'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Scissors, X, ArrowRightFromLine, ArrowLeftToLine, Keyboard } from 'lucide-react'

export function ManualCutBar() {
  // throttle the live playhead re-render to ~10 fps
  const playheadMs = usePlayhead((s) => Math.round(s.ms / 100) * 100)
  const markInMs = useStudio((s) => s.markInMs)
  const markOutMs = useStudio((s) => s.markOutMs)
  const setMarkIn = useStudio((s) => s.setMarkIn)
  const setMarkOut = useStudio((s) => s.setMarkOut)
  const clearMarks = useStudio((s) => s.clearMarks)
  const addManualRegion = useStudio((s) => s.addManualRegion)
  const selectedRegionId = useStudio((s) => s.selectedRegionId)
  const deleteRegion = useStudio((s) => s.deleteRegion)
  const decisions = useStudio((s) => s.decisions)

  const bothSet = markInMs != null && markOutMs != null
  const selRegion = decisions?.regions.find((r) => r.id === selectedRegionId)
  const selDeletable =
    !!selRegion && (selRegion.kind === 'manual' || selRegion.kind === 'silence' || selRegion.kind === 'filler' || selRegion.kind === 'repetition' || selRegion.kind === 'mistake' || selRegion.kind === 'offtopic')

  return (
    <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-2.5">
      <div className="flex flex-wrap items-center gap-2" dir="rtl">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMarkIn(currentPlayheadMs())}
          className={cn(
            'h-8 gap-1.5 border-zinc-800 bg-zinc-900 px-2.5 text-xs',
            markInMs != null ? 'border-amber-600/60 text-amber-300' : 'text-zinc-300 hover:border-amber-700/60 hover:text-amber-300'
          )}
        >
          <ArrowRightFromLine className="h-3.5 w-3.5" />
          بداية القص
          <kbd className="rounded-sm border border-zinc-700 bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">I</kbd>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMarkOut(currentPlayheadMs())}
          className={cn(
            'h-8 gap-1.5 border-zinc-800 bg-zinc-900 px-2.5 text-xs',
            markOutMs != null ? 'border-amber-600/60 text-amber-300' : 'text-zinc-300 hover:border-amber-700/60 hover:text-amber-300'
          )}
        >
          <ArrowLeftToLine className="h-3.5 w-3.5" />
          نهاية القص
          <kbd className="rounded-sm border border-zinc-700 bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">O</kbd>
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => addManualRegion()}
          disabled={!bothSet}
          className="h-8 gap-1.5 bg-amber-500 px-3 text-xs font-semibold text-black hover:bg-amber-400 disabled:opacity-40"
        >
          <Scissors className="h-3.5 w-3.5" />
          قص الجزء المحدد
          <kbd className="rounded-sm border border-black/30 bg-black/10 px-1 font-mono text-[10px]">A</kbd>
        </Button>
        {(markInMs != null || markOutMs != null) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={clearMarks}
            className="h-8 gap-1 px-2 text-xs text-zinc-400 hover:text-zinc-100"
          >
            <X className="h-3.5 w-3.5" />
            إلغاء التحديد
          </Button>
        )}
        {selDeletable && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => selectedRegionId && deleteRegion(selectedRegionId)}
            className="h-8 gap-1 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <X className="h-3.5 w-3.5" />
            حذف القصة المحددة
            <kbd className="rounded-sm border border-zinc-700 bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">Del</kbd>
          </Button>
        )}

        {/* live state */}
        <div className="mr-auto flex items-center gap-2 font-mono text-[11px] text-zinc-400" dir="ltr">
          <span className="text-amber-400/90">{fmtTimecode(playheadMs)}</span>
          {markInMs != null && (
            <span className="rounded-sm border border-amber-700/50 bg-amber-950/40 px-1.5 py-0.5 text-amber-300">
              IN {fmtTimecode(markInMs)}
            </span>
          )}
          {markOutMs != null && (
            <span className="rounded-sm border border-amber-700/50 bg-amber-950/40 px-1.5 py-0.5 text-amber-300">
              OUT {fmtTimecode(markOutMs)}
            </span>
          )}
          {bothSet && (
            <span className="text-emerald-400">
              ({(Math.abs(markOutMs! - markInMs!) / 1000).toFixed(2)}s)
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500" dir="rtl">
        <span className="flex items-center gap-1">
          <Keyboard className="h-3 w-3" />
          اختصارات: <kbd className="font-mono text-zinc-400">I</kbd> بداية ·
          <kbd className="font-mono text-zinc-400">O</kbd> نهاية ·
          <kbd className="font-mono text-zinc-400">A</kbd> قص ·
          <kbd className="font-mono text-zinc-400">Space</kbd> تشغيل ·
          <kbd className="font-mono text-zinc-400">Del</kbd> حذف ·
          <kbd className="font-mono text-zinc-400">Esc</kbd> إلغاء
        </span>
        <span className="text-zinc-600">شغّل الفيديو، حدّد أي جزء مش عاجبك من بدايته لنهايته، واضغط «قص» — وبعدين Render.</span>
      </div>
    </div>
  )
}

export default ManualCutBar
