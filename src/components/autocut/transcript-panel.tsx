'use client'

/**
 * Text-based montage panel (Gling-style): the video's speech transcript, one
 * sentence per row. AI-flagged sentences are tinted red with the reason;
 * deleting a sentence creates a cut region, restoring it removes the region.
 * Clicking a row seeks the player to that sentence.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '@/lib/autocut/store'
import { usePlayhead } from '@/lib/autocut/playhead'
import { seekPlayer } from '@/components/autocut/player'
import { fmtTimecode } from '@/lib/autocut/format'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Redo2, RotateCcw, Scissors, Sparkles, Trash2, Undo2 } from 'lucide-react'
import type { TranscriptEntry, TranscriptVerdict } from '@/lib/autocut/types'

/** Arabic label for each AI verdict category. */
const CATEGORY_LABEL: Record<TranscriptVerdict['category'], string> = {
  filler: 'حشو',
  repetition: 'تكرار',
  false_start: 'بداية غلط',
  off_topic: 'خارج الموضوع',
}

type TranscriptFilter = 'all' | 'suggested' | 'deleted'

/** Same thin-scrollbar styling the regions table uses on its max-h lists. */
const SCROLLBAR_CLS =
  '[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent'

const RED_BADGE_CLS = 'rounded-sm border border-red-800/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-medium text-red-300'

/* ------------------------------------------------------------------ */
/* One sentence row (memoized — the transcript can be ~1200 rows and   */
/* only rows whose deleted/active flags changed should ever re-render). */
/* ------------------------------------------------------------------ */

interface TranscriptRowProps {
  entry: TranscriptEntry
  deleted: boolean
  active: boolean
  onDelete: (idx: number) => void
  onRestore: (idx: number) => void
}

const TranscriptRow = memo(function TranscriptRow({ entry, deleted, active, onDelete, onRestore }: TranscriptRowProps) {
  const verdict = entry.verdict
  return (
    <div
      dir="rtl"
      data-utt={entry.idx}
      aria-current={active ? 'true' : undefined}
      onClick={() => seekPlayer(entry.startMs)}
      className={cn(
        'group cursor-pointer rounded-lg border px-3 py-2 transition-colors',
        !deleted && verdict && 'border-red-800/60 bg-red-950/20 hover:bg-red-950/40',
        !deleted && !verdict && 'border-zinc-800 bg-zinc-900/20 hover:bg-zinc-800/40',
        deleted && verdict && 'border-red-900/40 bg-red-950/10 hover:bg-red-950/25',
        deleted && !verdict && 'border-zinc-800/60 bg-zinc-900/10 hover:bg-zinc-900/30',
        active && 'ring-1 ring-amber-500/60',
        active && !deleted && (verdict ? 'bg-red-950/40' : 'bg-zinc-800/40'),
      )}
    >
      <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1">
        {/* sentence text (reading start = right in RTL) */}
        <div className="min-w-[130px] flex-1">
          <p
            className={cn(
              'text-sm leading-relaxed',
              verdict ? 'text-red-100' : 'text-zinc-200',
              deleted && 'line-through opacity-60',
            )}
          >
            {entry.text || <span className="italic text-zinc-600">(كلام همس/مش واضح)</span>}
          </p>
          {verdict && active && !deleted && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-red-400/80">{verdict.reason}</p>
          )}
        </div>

        {/* verdict category + action */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {verdict && (
            <span
              title={verdict.reason}
              className={cn(RED_BADGE_CLS, deleted && 'border-red-900/50 bg-red-950/25 text-red-400/70')}
            >
              {CATEGORY_LABEL[verdict.category]}
            </span>
          )}
          {deleted ? (
            <>
              <span className="rounded-sm border border-emerald-800/60 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                متشالة ✓
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  onRestore(entry.idx)
                }}
                title="رجّع الجملة للفيديو"
                className="h-8 gap-1 px-2 text-xs text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                رجّعها
              </Button>
            </>
          ) : verdict ? (
            <Button
              type="button"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(entry.idx)
              }}
              title="امسح الجملة دي من الفيديو"
              className="h-8 gap-1 border-red-900/60 bg-red-950/30 px-2.5 text-xs text-red-200 hover:bg-red-950/60 hover:text-red-100"
            >
              <Scissors className="h-3.5 w-3.5" />
              امسحها نهائي
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(entry.idx)
              }}
              title="امسح الجملة دي من الفيديو"
              className="h-8 gap-1 px-2 text-xs text-zinc-500 opacity-80 hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
            >
              <Scissors className="h-3.5 w-3.5" />
              امسح
            </Button>
          )}
        </div>

        {/* left gutter: muted timecode */}
        <span className="shrink-0 pt-1 font-mono text-[10px] text-zinc-500" dir="ltr">
          {fmtTimecode(entry.startMs)}
        </span>
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* TranscriptPanel                                                     */
/* ------------------------------------------------------------------ */

export function TranscriptPanel() {
  const transcript = useStudio((s) => s.transcript)
  const transcriptLoading = useStudio((s) => s.transcriptLoading)
  const decisions = useStudio((s) => s.decisions)
  const triggerSmart = useStudio((s) => s.triggerSmart)
  const deleteUtterance = useStudio((s) => s.deleteUtterance)
  const restoreUtterance = useStudio((s) => s.restoreUtterance)
  const deleteAllSuggested = useStudio((s) => s.deleteAllSuggested)
  const undo = useStudio((s) => s.undo)
  const redo = useStudio((s) => s.redo)
  const canUndo = useStudio((s) => s.canUndo)
  const canRedo = useStudio((s) => s.canRedo)

  const [filter, setFilter] = useState<TranscriptFilter>('all')
  const [starting, setStarting] = useState(false)

  /** Region ids of already-removed sentences: `utt-<idx>` / `smart-<idx>`. */
  const deletedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of decisions?.regions ?? []) ids.add(r.id)
    return ids
  }, [decisions])

  const stats = useMemo(() => {
    const c = { total: 0, suggested: 0, filler: 0, repetition: 0, falseStart: 0, offTopic: 0, pending: 0 }
    if (!transcript) return c
    for (const t of transcript) {
      c.total++
      if (!t.verdict) continue
      c.suggested++
      if (t.verdict.category === 'filler') c.filler++
      else if (t.verdict.category === 'repetition') c.repetition++
      else if (t.verdict.category === 'false_start') c.falseStart++
      else c.offTopic++
      if (!deletedIds.has(`smart-${t.idx}`) && !deletedIds.has(`utt-${t.idx}`)) c.pending++
    }
    return c
  }, [transcript, deletedIds])

  const filtered = useMemo(() => {
    if (!transcript) return []
    if (filter === 'suggested') return transcript.filter((t) => t.verdict != null)
    if (filter === 'deleted') {
      return transcript.filter((t) => deletedIds.has(`utt-${t.idx}`) || deletedIds.has(`smart-${t.idx}`))
    }
    return transcript
  }, [transcript, filter, deletedIds])

  // Active sentence: throttled playhead subscription (re-render ≤ 4×/s).
  const bucketMs = usePlayhead((s) => Math.round(s.ms / 250) * 250)
  const activeIdx = useMemo(() => {
    if (!transcript) return null
    for (const t of transcript) {
      if (bucketMs >= t.startMs && bucketMs < t.endMs) return t.idx
    }
    return null
  }, [transcript, bucketMs])

  // Auto-scroll the active row into view — but only when it CHANGES, and
  // never fight the user (a manual scroll pauses the follow for 3 s).
  const listRef = useRef<HTMLDivElement>(null)
  const lastActiveIdx = useRef<number | null>(null)
  const lastUserScrollAt = useRef(0)
  const selfScrollUntil = useRef(0)

  useEffect(() => {
    if (activeIdx == null || activeIdx === lastActiveIdx.current) return
    lastActiveIdx.current = activeIdx
    const list = listRef.current
    if (!list) return
    const engaged = list.matches(':hover') || list.contains(document.activeElement)
    if (!engaged && Date.now() - lastUserScrollAt.current < 3000) return
    const row = list.querySelector<HTMLElement>(`[data-utt="${activeIdx}"]`)
    if (!row) return
    // our own smooth scroll also fires scroll events — don't count it as user input
    selfScrollUntil.current = Date.now() + 900
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIdx])

  const onListScroll = () => {
    if (Date.now() < selfScrollUntil.current) return
    lastUserScrollAt.current = Date.now()
  }

  // ---- empty state: smart pass not run yet --------------------------------
  if (transcript == null && !transcriptLoading) {
    return (
      <div
        dir="rtl"
        className="flex flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/40">
          <Sparkles className="h-5 w-5 text-amber-400" />
        </div>
        <div className="text-sm font-semibold text-zinc-100">مونتاج بالنص — زي Gling</div>
        <p className="max-w-lg text-xs leading-relaxed text-zinc-400">
          هنفرّغ الكلام نص جملة جملة، والذكاء الاصطناعي يعلمّ الحشو والتكرار والبدايات الغلط بالأحمر — تدوس امسح تتشال من
          الفيديو
        </p>
        <Button
          type="button"
          onClick={() => {
            setStarting(true)
            void triggerSmart().finally(() => setStarting(false))
          }}
          disabled={starting}
          className="h-9 gap-1.5 bg-amber-500 px-4 text-xs font-semibold text-black hover:bg-amber-400 disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {starting ? 'بدأ التحليل…' : 'حلّل الكلام وطلّع النص'}
        </Button>
        <p className="max-w-lg text-[10px] leading-relaxed text-zinc-600">
          التحليل بياخد وقت على فيديو ٥٤ دقيقة (بيفضّل متصفحك مفتوح أو تقدر تقفل وترجع تلاقيه خلص — بيكمل لوحده على
          السيرفر)
        </p>
        <p className="max-w-lg text-[10px] leading-relaxed text-amber-500/70">
          ⚠️ مفيش أي قص بيحصل أوتوماتيك — الأحمر مجرد اقتراح، وانت اللي بتشوف وبتقرر. وراجع الجملة بالسمع قبل ما
          تشيلها: دقة التفريغ بتختلف حسب وضوح الكلام واللهجة.
        </p>
      </div>
    )
  }

  // ---- loading: transcript being fetched -----------------------------------
  if (transcript == null) {
    return (
      <div className="w-full rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" dir="rtl">
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-zinc-800/60" />
          ))}
        </div>
        <p className="mt-2 text-center text-[10px] text-zinc-600">بنجيب النص…</p>
      </div>
    )
  }

  // ---- loaded: the sentence list -------------------------------------------
  const emptyText =
    transcript.length === 0
      ? 'النص فاضي — مفيش كلام متفرّغ في الفيديو'
      : filter === 'suggested'
        ? 'مفيش مقترحات حذف بالأحمر ✨'
        : 'مفيش جمل متشالة لسه'

  return (
    <div className="w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40" dir="rtl">
      {/* header: summary + bulk actions */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-zinc-800 p-3">
        <span className="text-xs font-medium text-zinc-200">
          {stats.total} جملة · {stats.suggested} مقترح حذف
        </span>
        {stats.suggested > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            {stats.filler > 0 && <span className={RED_BADGE_CLS}>حشو {stats.filler}</span>}
            {stats.repetition > 0 && <span className={RED_BADGE_CLS}>تكرار {stats.repetition}</span>}
            {stats.falseStart > 0 && <span className={RED_BADGE_CLS}>بداية غلط {stats.falseStart}</span>}
            {stats.offTopic > 0 && <span className={RED_BADGE_CLS}>خارج الموضوع {stats.offTopic}</span>}
          </span>
        )}
        <div className="mr-auto flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            onClick={deleteAllSuggested}
            disabled={stats.suggested === 0 || stats.pending === 0}
            title="امسح كل الجمل اللي الذكاء الاصطناعي رشّح حذفها"
            className="h-8 gap-1.5 bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            امسح كل المقترحات ({stats.suggested})
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={undo}
            disabled={!canUndo}
            title="تراجع (Ctrl+Z)"
            aria-label="تراجع"
            className="h-8 w-8 px-0 text-zinc-400 hover:text-zinc-100"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={redo}
            disabled={!canRedo}
            title="إعادة (Ctrl+Shift+Z)"
            aria-label="إعادة"
            className="h-8 w-8 px-0 text-zinc-400 hover:text-zinc-100"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
        {(
          [
            ['all', 'الكل'],
            ['suggested', 'المقترحات بالأحمر'],
            ['deleted', 'المتشالة'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
              filter === value
                ? 'border-amber-700/60 bg-amber-950/40 text-amber-300'
                : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
            )}
          >
            {label}
          </button>
        ))}
        {filter !== 'all' && (
          <span className="mr-auto text-[10px] text-zinc-600">
            {filtered.length} من {transcript.length}
          </span>
        )}
      </div>

      {/* sentences */}
      <div
        ref={listRef}
        onScroll={onListScroll}
        className={cn('flex max-h-[420px] scroll-smooth flex-col gap-1.5 overflow-y-auto p-2', SCROLLBAR_CLS)}
      >
        {filtered.map((entry) => (
          <TranscriptRow
            key={entry.idx}
            entry={entry}
            deleted={deletedIds.has(`utt-${entry.idx}`) || deletedIds.has(`smart-${entry.idx}`)}
            active={entry.idx === activeIdx}
            onDelete={deleteUtterance}
            onRestore={restoreUtterance}
          />
        ))}
        {filtered.length === 0 && <div className="py-10 text-center text-xs text-zinc-600">{emptyText}</div>}
      </div>

      <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600">
        دوس على أي جملة عشان الفيديو يروح ليها — كل حذف/رجوع بيتسجل تلقائي وتقدر تتراجع بـ Ctrl+Z
      </div>
    </div>
  )
}

export default TranscriptPanel
