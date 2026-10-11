'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  Ear,
  Eye,
  GaugeCircle,
  Loader2,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  TriangleAlert,
  Waves,
  Wind,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { fmtDuration } from '@/lib/autocut/format'
import { useStudio } from '@/lib/autocut/store'
import {
  SETTINGS_PRESETS,
  type DetectionSettings,
  type RenderSettings,
  type SettingsPreset,
} from '@/lib/autocut/types'
import { cn } from '@/lib/utils'
import { OptionSelect, type Option } from '@/components/autocut/option-select'

type IconComponent = React.ComponentType<{ className?: string }>

/* ------------------------------------------------------------------ */
/* Static option sets                                                   */
/* ------------------------------------------------------------------ */

const secLabel = (ms: number) => {
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : s.toFixed(1)} sec`
}

const MIN_SILENCE_OPTIONS: Option[] = [100, 200, 300, 500, 700, 1000, 1500, 2000, 3000].map(
  (v) => ({ value: v, label: secLabel(v) }),
)

const TARGET_SILENCE_OPTIONS: Option[] = [0, 100, 200, 300, 500, 700, 1000].map((v) => ({
  value: v,
  label: v === 0 ? '0 ms (remove)' : `${v} ms`,
}))

const PADDING_OPTIONS: Option[] = [0, 50, 100, 150, 200, 300, 500, 750, 1000].map((v) => ({
  value: v,
  label: `${v} ms`,
}))

const MAX_REMOVAL_OPTIONS: Option[] = [
  { value: null, label: 'Unlimited' },
  { value: 200, label: '200 ms' },
  { value: 500, label: '500 ms' },
  { value: 1000, label: '1 sec' },
]

const MAX_SILENCE_OPTIONS: Option[] = [
  { value: null, label: 'Unlimited' },
  { value: 2000, label: '2 sec' },
  { value: 5000, label: '5 sec' },
  { value: 10000, label: '10 sec' },
]

const FADE_OPTIONS: Option[] = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 ms' },
  { value: 10, label: '10 ms' },
  { value: 20, label: '20 ms' },
]

const ADVANCED_TOGGLES: {
  key: 'smartPadding' | 'breathingProtection' | 'lowSpeechProtection' | 'noiseTolerance'
  label: string
  description: string
  icon: IconComponent
}[] = [
  {
    key: 'smartPadding',
    label: 'Smart Padding',
    description: 'Snap cut boundaries to waveform energy minima to protect words.',
    icon: Waves,
  },
  {
    key: 'breathingProtection',
    label: 'Protect Breathing',
    description: 'Keep normal breaths instead of treating them as cuttable silence.',
    icon: Wind,
  },
  {
    key: 'lowSpeechProtection',
    label: 'Protect Low Speech',
    description: 'Never treat very quiet speech as silence.',
    icon: Ear,
  },
  {
    key: 'noiseTolerance',
    label: 'Background Noise Tolerance',
    description: 'Auto-compensate for constant room tone and background noise.',
    icon: GaugeCircle,
  },
]

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function matchesPreset(settings: DetectionSettings, preset: SettingsPreset): boolean {
  return (Object.keys(preset.settings) as (keyof DetectionSettings)[]).every(
    (key) => settings[key] === preset.settings[key],
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">{children}</p>
  )
}

function StatRow({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={cn('font-mono text-sm', accent ? 'text-amber-400' : 'text-zinc-200')}>
        {value}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* ControlsPanel — right sidebar of the Auto Cut editor                 */
/* ------------------------------------------------------------------ */

export function ControlsPanel() {
  const {
    job,
    settings,
    decisions,
    warnings,
    decisionsDirty,
    envelopeInfo,
    setSettings,
    applyPreset,
    resetSettings,
    reDetect,
    startRender,
    setPlayerMode,
    getStats,
  } = useStudio()

  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [detecting, setDetecting] = React.useState(false)
  const [rendering, setRendering] = React.useState(false)

  const stats = getStats()
  const gopMs = job?.meta?.gopMs ?? null
  const fadeMs = decisions?.render.fadeMs ?? 0
  const renderMode = decisions?.render.renderMode ?? 'precision'
  const actionsDisabled = !decisions || detecting || rendering

  const setRender = (patch: Partial<RenderSettings>) => {
    useStudio.setState((s) => ({
      decisions: s.decisions
        ? { ...s.decisions, render: { ...s.decisions.render, ...patch } }
        : s.decisions,
      decisionsDirty: true,
    }))
  }

  const runDetect = async () => {
    if (detecting) return
    setDetecting(true)
    try {
      await reDetect()
      const fresh = useStudio.getState().getStats()
      toast.success(`Detection complete — ${fresh ? fresh.regionCount : 0} cuts found`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Detection failed')
    } finally {
      setDetecting(false)
    }
  }

  const runRender = async () => {
    if (rendering) return
    setRendering(true)
    try {
      await startRender()
      toast.success('Rendering started')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the render')
    } finally {
      setRendering(false)
    }
  }

  const runPreview = () => {
    setPlayerMode('autocut')
    toast.info('Preview mode: silences are skipped during playback')
  }

  const thresholdWord =
    settings.thresholdDb <= -51
      ? 'Very Low'
      : settings.thresholdDb <= -41
        ? 'Low'
        : settings.thresholdDb <= -31
          ? 'Medium'
          : 'High'

  const savedPct = stats?.savedPct ?? 0
  const confirmApply = savedPct > 40

  const reAnalyzeButton = (
    <Button
      type="button"
      onClick={decisionsDirty ? undefined : runDetect}
      disabled={detecting || !job}
      className="h-9 w-full bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400"
    >
      {detecting ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Scissors className="size-4" />
      )}
      {detecting ? 'Analyzing…' : 'Re-analyze'}
    </Button>
  )

  const applyButton = (
    <Button
      type="button"
      onClick={confirmApply ? undefined : runRender}
      disabled={actionsDisabled}
      className="h-9 w-full bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400"
    >
      {rendering ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
      {rendering ? 'Starting…' : 'Apply Auto Cut'}
    </Button>
  )

  return (
    <div className="flex w-full flex-col gap-4 text-zinc-100">
      {/* 1 — Header */}
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-amber-400" />
        <h2 className="text-sm font-semibold tracking-wide">AUTO CUT</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={resetSettings}
              aria-label="Reset settings to defaults"
              className="ml-auto size-8 text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="border border-zinc-700 bg-zinc-800 text-zinc-100">
            Reset settings to defaults
          </TooltipContent>
        </Tooltip>
      </div>

      <Separator className="bg-zinc-800/80" />

      {/* 2 — Presets */}
      <section className="flex flex-col gap-2.5">
        <SectionHeader>Presets</SectionHeader>
        <div className="grid grid-cols-3 gap-2">
          {SETTINGS_PRESETS.map((preset) => {
            const active = matchesPreset(settings, preset)
            return (
              <Tooltip key={preset.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    aria-pressed={active}
                    className={cn(
                      'h-8 rounded-md border px-2 text-xs font-medium transition-colors',
                      active
                        ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
                    )}
                  >
                    {preset.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  sideOffset={6}
                  className="max-w-52 border border-zinc-700 bg-zinc-800 text-zinc-100"
                >
                  {preset.description}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 3 — Silence sensitivity */}
      <section className="flex flex-col gap-2">
        <SectionHeader>Silence Sensitivity</SectionHeader>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Threshold</span>
          <span className="font-mono text-xs text-zinc-400">{settings.thresholdDb} dB</span>
        </div>
        <Slider
          min={-60}
          max={-20}
          step={1}
          value={[settings.thresholdDb]}
          onValueChange={(v) => setSettings({ thresholdDb: v[0] ?? settings.thresholdDb })}
          aria-label="Silence threshold"
          className="[&_[data-slot=slider-track]]:bg-zinc-800 [&_[data-slot=slider-range]]:bg-amber-500 [&_[data-slot=slider-thumb]]:border-amber-400 [&_[data-slot=slider-thumb]]:bg-zinc-900 [&_[data-slot=slider-thumb]]:ring-amber-500/25 [&_[data-slot=slider-thumb]]:focus-visible:ring-amber-500/30"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-amber-400/90">{thresholdWord}</span>
          <span className="font-mono text-[10px] text-zinc-600">−60 dB … −20 dB</span>
        </div>
        <p className="text-[11px] leading-snug text-zinc-500">
          Quieter parts count as silence above this level. Higher = more aggressive removal.
        </p>
        {envelopeInfo ? (
          <p className="font-mono text-[11px] text-zinc-600">
            Noise floor {envelopeInfo.noiseFloorDb} dB · range {envelopeInfo.dynamicRangeDb} dB
          </p>
        ) : null}
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 4 — Minimum silence */}
      <section className="flex flex-col">
        <OptionSelect
          label="Minimum Silence"
          value={settings.minSilenceMs}
          options={MIN_SILENCE_OPTIONS}
          onChange={(v) => setSettings({ minSilenceMs: v ?? 100 })}
          unit="sec"
          scale={0.001}
          min={100}
          max={10000}
          hint="Shorter pauses are always kept"
        />
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 5 — Compress toggle + target */}
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-zinc-300">Compress silence</span>
            <span className="text-[11px] leading-snug text-zinc-500">
              Keep a short pause instead of removing it entirely
            </span>
          </div>
          <Switch
            checked={settings.compressSilence}
            onCheckedChange={(v) => setSettings({ compressSilence: v })}
            aria-label="Compress silence (keep a short pause)"
            className="mt-0.5 data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-zinc-800 dark:data-[state=checked]:bg-amber-500 dark:data-[state=unchecked]:bg-zinc-800"
          />
        </div>
        {settings.compressSilence ? (
          <OptionSelect
            label="Target Silence"
            value={settings.targetSilenceMs}
            options={TARGET_SILENCE_OPTIONS}
            onChange={(v) => setSettings({ targetSilenceMs: v ?? 0 })}
            min={0}
            max={10000}
            hint="Each pause is shortened to this length instead of removed"
          />
        ) : null}
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 6 — Keep before / after */}
      <section className="flex flex-col gap-3">
        <OptionSelect
          label="Keep Before"
          value={settings.keepBeforeMs}
          options={PADDING_OPTIONS}
          onChange={(v) => setSettings({ keepBeforeMs: v ?? 0 })}
          min={0}
          max={5000}
          hint="Padding before silence"
        />
        <OptionSelect
          label="Keep After"
          value={settings.keepAfterMs}
          options={PADDING_OPTIONS}
          onChange={(v) => setSettings({ keepAfterMs: v ?? 0 })}
          min={0}
          max={5000}
          hint="Padding after silence"
        />
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 7 — Maximum removal */}
      <section className="flex flex-col">
        <OptionSelect
          label="Maximum Removal"
          value={settings.maxRemovalMs}
          options={MAX_REMOVAL_OPTIONS}
          onChange={(v) => setSettings({ maxRemovalMs: v })}
          min={0}
          max={60000}
          hint="Cap how much may be removed from a single pause"
        />
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 8 — Advanced */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 py-1 text-[10px] font-medium uppercase tracking-widest text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Advanced
            <ChevronDown
              className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-1">
          <OptionSelect
            label="Max Silence Duration"
            value={settings.maxSilenceMs}
            options={MAX_SILENCE_OPTIONS}
            onChange={(v) => setSettings({ maxSilenceMs: v })}
            min={500}
            max={600000}
            hint="Longer silences are left untouched"
          />
          {ADVANCED_TOGGLES.map(({ key, label: toggleLabel, description, icon: Icon }) => (
            <div key={key} className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-zinc-300">{toggleLabel}</span>
                  <span className="text-[11px] leading-snug text-zinc-500">{description}</span>
                </div>
              </div>
              <Switch
                checked={settings[key]}
                onCheckedChange={(v) => setSettings({ [key]: v })}
                aria-label={toggleLabel}
                className="mt-0.5 data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-zinc-800 dark:data-[state=checked]:bg-amber-500 dark:data-[state=unchecked]:bg-zinc-800"
              />
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>

      <Separator className="bg-zinc-800/80" />

      {/* 9 — Re-analyze */}
      {decisionsDirty ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>{reAnalyzeButton}</AlertDialogTrigger>
          <AlertDialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Re-run detection?</AlertDialogTitle>
              <AlertDialogDescription className="text-zinc-400">
                Re-analyzing replaces your manual edits — boundary changes, splits, and
                keep/remove/compress overrides will be lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={runDetect}
                className="bg-amber-500 text-zinc-950 hover:bg-amber-400"
              >
                Re-analyze
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        reAnalyzeButton
      )}

      {/* 10 — Statistics */}
      <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <StatRow label="Detected Cuts" value={stats ? String(stats.regionCount) : '—'} />
        <StatRow
          label="Total Silence"
          value={stats ? fmtDuration(stats.totalSilenceMs, { compact: true }) : '—'}
        />
        <StatRow
          label="Will Remove"
          value={stats ? fmtDuration(stats.willRemoveMs, { compact: true }) : '—'}
        />
        <StatRow
          label="Final Duration"
          value={stats ? fmtDuration(stats.finalDurationMs, { compact: true }) : '—'}
        />
        <StatRow
          label="Time Saved"
          accent
          value={
            stats
              ? `${fmtDuration(stats.willRemoveMs, { compact: true })} · ${stats.savedPct.toFixed(1)}%`
              : '—'
          }
        />
      </div>

      {/* 11 — Warnings */}
      {warnings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionHeader>Warnings</SectionHeader>
          {warnings.map((w, i) => (
            <div
              key={i}
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-xs leading-snug text-amber-200/90"
            >
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-400" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 12 — Output */}
      <section className="flex flex-col gap-3">
        <SectionHeader>Output</SectionHeader>
        <OptionSelect
          label="Audio Fade"
          value={fadeMs}
          options={FADE_OPTIONS}
          onChange={(v) => setRender({ fadeMs: v ?? 0 })}
          min={0}
          max={500}
          disabled={!decisions}
          hint="Short crossfade at every cut join"
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Render Mode</span>
          <div className="grid grid-cols-2 gap-2">
            {(['precision', 'fast'] as const).map((mode) => {
              const active = renderMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={!decisions}
                  onClick={() => setRender({ renderMode: mode })}
                  aria-pressed={active}
                  className={cn(
                    'flex min-h-20 flex-col gap-1 rounded-md border p-2.5 text-left transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    active
                      ? 'border-amber-500/70 bg-amber-500/10'
                      : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600',
                  )}
                >
                  <span
                    className={cn(
                      'text-xs font-semibold',
                      active ? 'text-amber-300' : 'text-zinc-200',
                    )}
                  >
                    {mode === 'precision' ? 'Precision' : 'Fast'}
                  </span>
                  <span className="text-[11px] leading-snug text-zinc-500">
                    {mode === 'precision'
                      ? 'Frame-accurate re-encode, best quality (recommended)'
                      : 'Stream copy at keyframes, minutes instead of hours'}
                  </span>
                  {mode === 'fast' && gopMs ? (
                    <span className="font-mono text-[10px] text-zinc-600">
                      keyframes every ~{(gopMs / 1000).toFixed(1)}s
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <Separator className="bg-zinc-800/80" />

      {/* 13 — Actions */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={runPreview}
          disabled={actionsDisabled}
          className="h-9 border border-zinc-700 bg-zinc-800/60 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Eye className="size-4" />
          Preview Result
        </Button>
        {confirmApply ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>{applyButton}</AlertDialogTrigger>
            <AlertDialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle>Cut {savedPct.toFixed(1)}% of the video?</AlertDialogTitle>
                <AlertDialogDescription className="text-zinc-400">
                  Auto Cut will remove {fmtDuration(stats?.willRemoveMs ?? 0, { compact: true })} (
                  {savedPct.toFixed(1)}% of the runtime). Double-check the protected regions in the
                  review table before rendering.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={runRender}
                  className="bg-amber-500 text-zinc-950 hover:bg-amber-400"
                >
                  Apply Auto Cut
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          applyButton
        )}
      </div>
    </div>
  )
}

export default ControlsPanel
