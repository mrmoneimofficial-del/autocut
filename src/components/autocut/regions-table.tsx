'use client'

import * as React from 'react'
import {
  ArrowLeftRight,
  LocateFixed,
  Minimize2,
  Scissors,
  Search,
  ShieldCheck,
  Sparkles,
  SplitSquareHorizontal,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { fmtDuration, fmtTimecode } from '@/lib/autocut/format'
import { useStudio } from '@/lib/autocut/store'
import type { CutRegion, RegionAction } from '@/lib/autocut/types'
import { cn } from '@/lib/utils'

type IconComponent = React.ComponentType<{ className?: string }>

type RegionFilter = 'all' | 'remove' | 'keep' | 'compress' | 'protected' | 'smart'

const VISIBLE_CAP = 400

const KIND_LABEL: Record<CutRegion['kind'], string> = {
  silence: 'Silence',
  breath: 'Breath',
  lowspeech: 'Low speech',
  manual: 'Manual',
  filler: 'حشو',
  repetition: 'تكرار',
  mistake: 'غلط/إعادة',
  offtopic: 'خارج الموضوع',
}

const KIND_STYLE: Record<CutRegion['kind'], string> = {
  silence: 'border-zinc-700/60 bg-zinc-800/50 text-zinc-400',
  breath: 'border-teal-900/60 bg-teal-950/40 text-teal-300',
  lowspeech: 'border-violet-900/60 bg-violet-950/40 text-violet-300',
  manual: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
  filler: 'border-orange-900/60 bg-orange-950/40 text-orange-300',
  repetition: 'border-rose-900/60 bg-rose-950/40 text-rose-300',
  mistake: 'border-red-900/60 bg-red-950/40 text-red-300',
  offtopic: 'border-slate-600/60 bg-slate-800/40 text-slate-300',
}

const CUT_TINT: Record<RegionAction, string> = {
  remove: 'text-red-400/90',
  compress: 'text-orange-400/90',
  keep: 'text-zinc-500',
}

const cellCls = 'border-b border-zinc-800/60 px-2 py-1.5 align-middle'
const headCls =
  'sticky top-0 z-10 h-8 border-b border-zinc-800 bg-zinc-900 px-2 text-left align-middle text-[10px] font-medium uppercase tracking-wider text-zinc-500'

const SKELETON_WIDTHS = ['w-6', 'w-36', 'w-10', 'w-14', 'w-6', 'w-28', 'w-36', 'w-24']

/* ------------------------------------------------------------------ */
/* Small building blocks                                                */
/* ------------------------------------------------------------------ */

function IconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  activeClassName,
}: {
  icon: IconComponent
  label: string
  onClick: () => void
  active?: boolean
  activeClassName?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            if (!active) onClick()
          }}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-md border transition-colors',
            active && activeClassName
              ? activeClassName
              : 'border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200',
          )}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6} className="border border-zinc-700 bg-zinc-800 text-zinc-100">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function NudgeField({
  label,
  text,
  onTextChange,
  onNudge,
}: {
  label: string
  text: string
  onTextChange: (t: string) => void
  onNudge: (delta: number) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          value={text}
          aria-label={label}
          onChange={(e) => onTextChange(e.target.value)}
          className={cn(
            'h-8 min-w-0 flex-1 border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-200',
            'focus-visible:border-amber-500/50 focus-visible:ring-amber-500/20',
            'dark:border-zinc-800 dark:bg-zinc-950',
          )}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onNudge(-100)}
          className="h-8 border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          -100
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onNudge(100)}
          className="h-8 border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          +100
        </Button>
      </div>
    </div>
  )
}

/** Popover body for editing a region's cut window (and compress target). */
function BoundaryEditor({
  region,
  onApply,
  onClose,
}: {
  region: CutRegion
  onApply: (patch: { cutStartMs: number; cutEndMs: number; targetMs?: number }) => void
  onClose: () => void
}) {
  const globalTargetMs = useStudio.getState().decisions?.targetSilenceMs ?? null
  const [startText, setStartText] = React.useState(String(region.cutStartMs))
  const [endText, setEndText] = React.useState(String(region.cutEndMs))
  const [targetText, setTargetText] = React.useState(
    region.targetMs != null ? String(region.targetMs) : '',
  )

  const lo = region.startMs - 5000
  const hi = region.endMs + 5000
  const clampToWindow = (v: number) => Math.min(Math.max(Math.round(v), lo), hi)

  const nudge = (text: string, fallback: number, delta: number) => {
    const base = Number.parseInt(text, 10)
    return String(clampToWindow((Number.isFinite(base) ? base : fallback) + delta))
  }

  const nudgeStart = (delta: number) => setStartText(nudge(startText, region.cutStartMs, delta))
  const nudgeEnd = (delta: number) => setEndText(nudge(endText, region.cutEndMs, delta))

  const apply = () => {
    const startParsed = Number.parseInt(startText, 10)
    const endParsed = Number.parseInt(endText, 10)
    const patch: { cutStartMs: number; cutEndMs: number; targetMs?: number } = {
      cutStartMs: Number.isFinite(startParsed) ? clampToWindow(startParsed) : region.cutStartMs,
      cutEndMs: Number.isFinite(endParsed) ? clampToWindow(endParsed) : region.cutEndMs,
    }
    if (region.action === 'compress') {
      const target = Number.parseFloat(targetText)
      if (Number.isFinite(target)) patch.targetMs = Math.max(0, Math.round(target))
    }
    onApply(patch)
    onClose()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
          Edit boundaries
        </span>
        <span className="font-mono text-[10px] text-zinc-600">
          span {fmtDuration(region.endMs - region.startMs, { compact: true })}
        </span>
      </div>
      <p className="font-mono text-[11px] text-zinc-500">
        detected {fmtTimecode(region.startMs)} <span className="text-amber-400/70">→</span>{' '}
        {fmtTimecode(region.endMs)}
      </p>
      <NudgeField
        label="Cut start (ms)"
        text={startText}
        onTextChange={setStartText}
        onNudge={nudgeStart}
      />
      <NudgeField
        label="Cut end (ms)"
        text={endText}
        onTextChange={setEndText}
        onNudge={nudgeEnd}
      />
      {region.action === 'compress' ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Compress target (ms)
          </span>
          <Input
            type="number"
            value={targetText}
            aria-label="Compress target (ms)"
            placeholder={String(region.targetMs ?? globalTargetMs ?? 300)}
            onChange={(e) => setTargetText(e.target.value)}
            className={cn(
              'h-8 border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-200',
              'focus-visible:border-amber-500/50 focus-visible:ring-amber-500/20',
              'dark:border-zinc-800 dark:bg-zinc-950',
            )}
          />
        </div>
      ) : null}
      <p className="text-[10px] leading-snug text-zinc-600">
        Boundaries are clamped to ±5 s around the detected span.
      </p>
      <Button
        type="button"
        onClick={apply}
        className="h-8 w-full bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400"
      >
        Apply
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Row                                                                  */
/* ------------------------------------------------------------------ */

const RegionRow = React.memo(function RegionRow({
  region,
  index,
  selected,
}: {
  region: CutRegion
  index: number
  selected: boolean
}) {
  const [editOpen, setEditOpen] = React.useState(false)
  const { selectRegion, setRegionAction, splitRegion, patchRegion, deleteRegion } = useStudio.getState()
  const isSmart =
    region.kind === 'filler' || region.kind === 'repetition' || region.kind === 'mistake' || region.kind === 'offtopic'
  const editable = region.kind === 'silence' || region.kind === 'manual' || isSmart

  return (
    <TableRow
      onClick={() => selectRegion(region.id)}
      className={cn(
        'cursor-pointer border-b-0 hover:bg-zinc-800/40',
        selected &&
          'bg-amber-500/10 hover:bg-amber-500/10 [&>td:first-child]:shadow-[inset_2px_0_0_0_#fbbf24]',
      )}
    >
      <TableCell className={cn(cellCls, 'w-10 font-mono text-xs text-zinc-500')}>
        {index + 1}
      </TableCell>
      <TableCell className={cn(cellCls, 'font-mono text-xs text-zinc-300')}>
        {fmtTimecode(region.startMs)} <span className="text-amber-400/70">→</span>{' '}
        {fmtTimecode(region.endMs)}
      </TableCell>
      <TableCell className={cn(cellCls, 'font-mono text-xs text-zinc-400')}>
        {fmtDuration(region.endMs - region.startMs, { compact: true })}
      </TableCell>
      <TableCell className={cellCls}>
        <div className="flex flex-col gap-0.5">
          <Badge
            variant="outline"
            className={cn('px-1.5 py-0 text-[10px] font-medium', KIND_STYLE[region.kind])}
          >
            {isSmart ? <span className="flex items-center gap-1"><Sparkles className="size-2.5" />{KIND_LABEL[region.kind]}</span> : KIND_LABEL[region.kind]}
          </Badge>
          {isSmart && region.note ? (
            <span
              dir="rtl"
              title={region.note}
              className="max-w-[200px] truncate text-[10px] leading-tight text-zinc-500"
            >
              {region.note}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className={cellCls} title={`Confidence ${Math.round(region.confidence * 100)}%`}>
        <div className="h-1.5 w-6 rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-amber-500"
            style={{ width: `${Math.round(region.confidence * 100)}%` }}
          />
        </div>
      </TableCell>
      <TableCell className={cellCls} onClick={(e) => e.stopPropagation()}>
        {editable ? (
          <div className="flex items-center gap-1">
            <IconButton
              icon={ShieldCheck}
              label="Keep this region"
              active={region.action === 'keep'}
              activeClassName="border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
              onClick={() => setRegionAction(region.id, 'keep')}
            />
            <IconButton
              icon={Scissors}
              label="Remove this silence"
              active={region.action === 'remove'}
              activeClassName="border-red-500/50 bg-red-500/10 text-red-400"
              onClick={() => setRegionAction(region.id, 'remove')}
            />
            <IconButton
              icon={Minimize2}
              label="Compress this silence"
              active={region.action === 'compress'}
              activeClassName="border-orange-500/50 bg-orange-500/10 text-orange-400"
              onClick={() => setRegionAction(region.id, 'compress')}
            />
          </div>
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">
            Protected
          </span>
        )}
      </TableCell>
      <TableCell className={cn(cellCls, 'font-mono text-xs', CUT_TINT[region.action])}>
        {fmtTimecode(region.cutStartMs)} <span className="text-amber-400/70">→</span>{' '}
        {fmtTimecode(region.cutEndMs)}
      </TableCell>
      <TableCell className={cellCls} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <IconButton
            icon={LocateFixed}
            label="Locate on timeline"
            onClick={() => selectRegion(region.id)}
          />
          {editable ? (
            <IconButton
              icon={SplitSquareHorizontal}
              label="Split into two regions"
              onClick={() => splitRegion(region.id)}
            />
          ) : null}
          {editable ? (
            <IconButton
              icon={Trash2}
              label="حذف القطة نهائياً"
              onClick={() => deleteRegion(region.id)}
            />
          ) : null}
          <Popover open={editOpen} onOpenChange={setEditOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Edit cut boundaries"
                    className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/60 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                  >
                    <ArrowLeftRight className="size-4" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent
                sideOffset={6}
                className="border border-zinc-700 bg-zinc-800 text-zinc-100"
              >
                Edit cut boundaries
              </TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-80 border-zinc-800 bg-zinc-900 p-3 text-zinc-100">
              <BoundaryEditor
                region={region}
                onApply={(patch) => patchRegion(region.id, patch)}
                onClose={() => setEditOpen(false)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </TableCell>
    </TableRow>
  )
})

/* ------------------------------------------------------------------ */
/* RegionsTable — bottom review table                                   */
/* ------------------------------------------------------------------ */

export function RegionsTable() {
  const decisions = useStudio((s) => s.decisions)
  const selectedRegionId = useStudio((s) => s.selectedRegionId)
  const [filter, setFilter] = React.useState<RegionFilter>('all')
  const [query, setQuery] = React.useState('')

  const regions = React.useMemo(() => decisions?.regions ?? [], [decisions])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return regions.filter((r) => {
      if (filter === 'protected') {
        if (r.kind !== 'breath' && r.kind !== 'lowspeech') return false
      } else if (filter === 'smart') {
        if (r.kind !== 'filler' && r.kind !== 'repetition' && r.kind !== 'mistake' && r.kind !== 'offtopic') return false
      } else if (filter !== 'all' && r.action !== filter) {
        return false
      }
      if (q) {
        const haystack =
          `${fmtTimecode(r.startMs)} ${fmtTimecode(r.endMs)} ` +
          `${fmtTimecode(r.cutStartMs)} ${fmtTimecode(r.cutEndMs)} ` +
          fmtDuration(r.endMs - r.startMs, { compact: true }) +
          ` ${r.note ?? ''}`
        if (!haystack.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [regions, filter, query])

  const visible = React.useMemo(() => filtered.slice(0, VISIBLE_CAP), [filtered])

  const indexOf = React.useMemo(() => {
    const map = new Map<string, number>()
    regions.forEach((r, i) => map.set(r.id, i))
    return map
  }, [regions])

  const keepAll = () => useStudio.getState().keepAllRegions()
  const removeAll = () => useStudio.getState().removeAllRegions()

  const filtering = filter !== 'all' || query.trim() !== ''
  const countText = filtering
    ? `${filtered.length} of ${regions.length}`
    : `${regions.length}`

  return (
    <div className="w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 p-3">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as RegionFilter)}>
          <TabsList className="h-8 gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
            {(
              [
                ['all', 'All'],
                ['smart', 'ذكي ✦'],
                ['remove', 'Remove'],
                ['keep', 'Keep'],
                ['compress', 'Compress'],
                ['protected', 'Protected'],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                className={cn(
                  'px-2.5 text-xs text-zinc-500',
                  'data-[state=active]:bg-zinc-800 data-[state=active]:text-amber-300 data-[state=active]:shadow-none',
                  'dark:text-zinc-500 dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-zinc-800 dark:data-[state=active]:text-amber-300',
                )}
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-600" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search timecode"
            aria-label="Search timecode"
            className={cn(
              'h-8 w-40 border-zinc-800 bg-zinc-950 pl-8 text-xs text-zinc-200 sm:w-48',
              'placeholder:text-zinc-600 focus-visible:border-amber-500/50 focus-visible:ring-amber-500/20',
              'dark:border-zinc-800 dark:bg-zinc-950',
            )}
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            onClick={keepAll}
            className="h-8 px-2.5 text-xs text-zinc-400 hover:bg-emerald-500/10 hover:text-emerald-300 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
          >
            Keep All
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={removeAll}
            className="h-8 px-2.5 text-xs text-zinc-400 hover:bg-red-500/10 hover:text-red-300 dark:hover:bg-red-500/10 dark:hover:text-red-300"
          >
            Remove All
          </Button>
          <Separator orientation="vertical" className="mx-1 h-4 bg-zinc-800" />
          <span className="whitespace-nowrap text-xs text-zinc-500">{countText} cuts</span>
        </div>
      </div>

      {/* Table */}
      <div className="max-h-72 overflow-auto scroll-smooth [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
        <table className="w-full min-w-[880px] border-separate border-spacing-0">
          <TableHeader>
            <TableRow className="border-b-0 hover:bg-transparent">
              <TableHead className={cn(headCls, 'w-10')}>#</TableHead>
              <TableHead className={headCls}>Start → End</TableHead>
              <TableHead className={headCls}>Dur</TableHead>
              <TableHead className={headCls}>Type</TableHead>
              <TableHead className={headCls}>Conf</TableHead>
              <TableHead className={headCls}>Action</TableHead>
              <TableHead className={headCls}>Cut Window</TableHead>
              <TableHead className={headCls}>Tools</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {decisions == null
              ? Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`} className="border-b-0 hover:bg-transparent">
                    {SKELETON_WIDTHS.map((w, j) => (
                      <TableCell key={j} className={cellCls}>
                        <Skeleton className={cn('h-3.5 bg-zinc-800/70', w)} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : visible.length === 0 ? (
                  <TableRow key="empty" className="border-b-0 hover:bg-transparent">
                    <TableCell colSpan={8} className="px-2 py-10 text-center text-xs text-zinc-500">
                      {regions.length === 0 ? 'No cuts detected' : 'No cuts match the filter'}
                    </TableCell>
                  </TableRow>
                ) : visible.map((region) => (
                    <RegionRow
                      key={region.id}
                      region={region}
                      index={indexOf.get(region.id) ?? 0}
                      selected={region.id === selectedRegionId}
                    />
                  ))}
          </TableBody>
        </table>
      </div>

      {/* Cap footer */}
      {decisions != null && filtered.length > VISIBLE_CAP ? (
        <div className="border-t border-zinc-800 px-3 py-2 text-center text-[11px] text-zinc-500">
          Showing {VISIBLE_CAP} of {filtered.length} — refine the filter to see more
        </div>
      ) : null}
    </div>
  )
}

export default RegionsTable
