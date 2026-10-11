'use client'

import * as React from 'react'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface Option {
  /** Stored value; `null` means "unlimited / none". */
  value: number | null
  label: string
}

export interface OptionSelectProps {
  label: string
  /** Current stored value (`null` = unlimited). */
  value: number | null
  /** Ordered preset options; include a `null` option when unlimited applies. */
  options: Option[]
  onChange: (v: number | null) => void
  /** Display unit, e.g. 'ms' | 'sec' | 'dB'. */
  unit?: string
  /** Storage → display multiplier (0.001 shows seconds while storing ms). */
  scale?: number
  /** Custom input bounds, in STORAGE units (ms). */
  min?: number
  max?: number
  /** Small helper text below the control. */
  hint?: string
  disabled?: boolean
}

/** Select keys — Radix values must be strings. */
const NONE_KEY = '__none__'
const CUSTOM_KEY = '__custom__'

/**
 * Compact labeled select with preset options plus a "Custom…" escape hatch
 * that swaps the trigger for a numeric input (confirm on blur / Enter,
 * cancel with Escape).
 */
export function OptionSelect({
  label,
  value,
  options,
  onChange,
  unit = 'ms',
  scale = 1,
  min,
  max,
  hint,
  disabled = false,
}: OptionSelectProps) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const cancelledRef = React.useRef(false)

  const keyOf = (o: Option) => (o.value === null ? NONE_KEY : String(o.value))
  const matching = options.find((o) => o.value === value)

  const formatCustom = (v: number) => {
    const display = v * scale
    return `${scale < 1 ? display.toFixed(1) : display.toFixed(0)} ${unit}`
  }

  const currentLabel = matching
    ? matching.label
    : value === null
      ? 'Unlimited'
      : formatCustom(value)

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const handleSelect = (key: string) => {
    if (key === CUSTOM_KEY) {
      cancelledRef.current = false
      setDraft(value != null ? String(+(value * scale).toFixed(4)) : '')
      setEditing(true)
      return
    }
    const opt = options.find((o) => keyOf(o) === key)
    if (opt) onChange(opt.value)
  }

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      setEditing(false)
      return
    }
    setEditing(false)
    const raw = Number.parseFloat(draft)
    if (!Number.isFinite(raw)) return
    let storage = Math.round(raw / scale)
    if (min != null) storage = Math.max(min, storage)
    if (max != null) storage = Math.min(max, storage)
    onChange(storage)
  }

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
        <span
          className={cn(
            'font-mono text-xs',
            editing ? 'text-amber-400' : 'text-zinc-400',
          )}
        >
          {editing ? 'Custom' : currentLabel}
        </span>
      </div>

      {editing ? (
        <div className="relative">
          <Input
            ref={inputRef}
            type="number"
            value={draft}
            disabled={disabled}
            aria-label={`${label} — custom value in ${unit}`}
            placeholder="—"
            min={min != null ? +(min * scale).toFixed(4) : undefined}
            max={max != null ? +(max * scale).toFixed(4) : undefined}
            step={scale < 1 ? 0.1 : 1}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelledRef.current = true
                setEditing(false)
              }
            }}
            className={cn(
              'h-8 border-zinc-800 bg-zinc-950 pr-12 font-mono text-xs text-zinc-200',
              'focus-visible:border-amber-500/50 focus-visible:ring-amber-500/20',
              'dark:border-zinc-800 dark:bg-zinc-950',
            )}
          />
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10px] uppercase tracking-wide text-zinc-500">
            {unit}
          </span>
        </div>
      ) : (
        <Select
          value={matching ? keyOf(matching) : CUSTOM_KEY}
          onValueChange={handleSelect}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            aria-label={label}
            className={cn(
              'h-8 w-full border-zinc-800 bg-zinc-950 text-sm text-zinc-300',
              'hover:bg-zinc-900 focus-visible:border-amber-500/50 focus-visible:ring-amber-500/20',
              'data-[placeholder]:text-zinc-500',
              'dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900',
            )}
          >
            <SelectValue>{currentLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
            {options.map((o) => (
              <SelectItem
                key={keyOf(o)}
                value={keyOf(o)}
                className="text-zinc-300 focus:bg-zinc-800/70 focus:text-zinc-100"
              >
                {o.label}
              </SelectItem>
            ))}
            <SelectItem
              value={CUSTOM_KEY}
              className="text-amber-400/90 focus:bg-zinc-800/70 focus:text-amber-300"
            >
              Custom…
            </SelectItem>
          </SelectContent>
        </Select>
      )}

      {hint ? <p className="text-[11px] leading-snug text-zinc-500">{hint}</p> : null}
    </div>
  )
}
