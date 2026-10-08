'use client'

/**
 * قصّاص — UploadProgressCard
 * Ported from the مستر منعم src/components/upload-progress-card.tsx (palette
 * adapted to قصّاص's orange/zinc look; structure and behaviour identical).
 *
 * Auto-detects which mode to render: if chunkProgress is present → chunked UI
 * (speed + ETA + chunks + pause/resume), else → simple UI (loaded/total/%).
 */
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Pause, Play, X, CheckCircle2, AlertCircle, FileUp } from 'lucide-react'
import type { ChunkProgress, ChunkedUploadHandle } from '@/lib/chunked-upload'
import { formatBytes, formatSpeed, formatEta } from '@/lib/chunked-upload'

export interface SimpleUploadProgress {
  loaded: number
  total: number
  percent: number
}

interface UploadProgressCardProps {
  fileName: string
  chunkProgress?: ChunkProgress | null
  simpleProgress?: SimpleUploadProgress | null
  chunkHandle?: ChunkedUploadHandle | null
  onCancel?: () => void
  mergingLabel?: string
}

export function UploadProgressCard({
  fileName,
  chunkProgress,
  simpleProgress,
  chunkHandle,
  onCancel,
  mergingLabel = 'جاري المعالجة…',
}: UploadProgressCardProps) {
  const isChunked = !!chunkProgress
  const cp = chunkProgress
  const sp = simpleProgress

  // Final states (chunked only — simple uploads resolve too fast to show these)
  if (cp?.status === 'done') {
    return (
      <CardShell tone="success">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{fileName}</p>
            <p className="text-xs text-zinc-500">اكتمل الرفع</p>
          </div>
        </div>
      </CardShell>
    )
  }
  if (cp?.status === 'error') {
    return (
      <CardShell tone="error">
        <div className="flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{fileName}</p>
            <p className="text-xs text-rose-600">{cp.error || 'فشل الرفع'}</p>
          </div>
        </div>
      </CardShell>
    )
  }

  const isMerging = cp?.status === 'merging'
  const isPaused = cp?.status === 'paused'
  const percent = isChunked
    ? (cp?.percent ?? 0)
    : (sp?.percent ?? 0)
  const rounded = Math.min(100, Math.max(0, Math.round(percent)))

  // Loaded/total display
  const loaded = isChunked ? (cp?.uploadedBytes ?? 0) : (sp?.loaded ?? 0)
  const total = isChunked ? (cp?.totalBytes ?? 0) : (sp?.total ?? 0)

  return (
    <CardShell tone={isMerging || isPaused ? 'idle' : 'active'}>
      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className="shrink-0 w-9 h-9 rounded-lg bg-orange-500/10 text-orange-500 flex items-center justify-center">
          {isMerging ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FileUp className="w-4 h-4" />
          )}
        </div>

        {/* File name + meta */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" title={fileName}>
            {fileName}
          </p>
          <p className="text-xs text-zinc-500 tabular-nums">
            {isMerging
              ? mergingLabel
              : isPaused
                ? 'متوقف مؤقتاً'
                : total > 0
                  ? `${formatBytes(loaded)} / ${formatBytes(total)}`
                  : formatBytes(loaded)}
            {isChunked && cp && !isMerging && (
              <>
                {' · '}
                {cp.totalChunks > 0 && `${cp.uploadedChunks}/${cp.totalChunks} قطعة`}
                {cp.speed > 0 && ` · ${formatSpeed(cp.speed)}`}
                {cp.eta > 0 && cp.status === 'uploading' && ` · ${formatEta(cp.eta)}`}
              </>
            )}
          </p>
        </div>

        {/* Pause / Resume / Cancel controls */}
        <div className="shrink-0 flex items-center gap-1">
          {isChunked && chunkHandle && cp?.status === 'uploading' && (
            <button
              type="button"
              onClick={() => chunkHandle.pause()}
              title="إيقاف مؤقت"
              className="w-8 h-8 rounded-md hover:bg-zinc-100 flex items-center justify-center text-zinc-500 hover:text-zinc-900 transition"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          {isChunked && chunkHandle && isPaused && (
            <button
              type="button"
              onClick={() => chunkHandle.resume()}
              title="استئناف"
              className="w-8 h-8 rounded-md hover:bg-orange-100 flex items-center justify-center text-zinc-500 hover:text-orange-600 transition"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
          {(onCancel || (isChunked && chunkHandle)) && (
            <button
              type="button"
              onClick={() => (onCancel ? onCancel() : chunkHandle?.cancel())}
              title="إلغاء"
              className="w-8 h-8 rounded-md hover:bg-rose-50 flex items-center justify-center text-zinc-500 hover:text-rose-600 transition"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 w-full rounded-full bg-zinc-100 overflow-hidden">
        <motion.div
          className="h-full rounded-full bg-orange-500"
          initial={{ width: 0 }}
          animate={{ width: `${rounded}%` }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 tabular-nums font-bold">{rounded}%</span>
        {isChunked && cp && cp.status === 'uploading' && cp.totalChunks > 0 && (
          <span className="text-[10px] text-zinc-400 tabular-nums">
            قطعة {cp.uploadedChunks} من {cp.totalChunks}
          </span>
        )}
      </div>
    </CardShell>
  )
}

/** Card shell with tone-based accent */
function CardShell({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'active' | 'success' | 'error' | 'idle'
}) {
  const accent =
    tone === 'success'
      ? 'border-emerald-200 bg-emerald-50/60'
      : tone === 'error'
        ? 'border-rose-200 bg-rose-50/60'
        : tone === 'idle'
          ? 'border-zinc-200 bg-zinc-50'
          : 'border-orange-200 bg-orange-50/60'
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className={`rounded-xl border p-3 ${accent}`}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
