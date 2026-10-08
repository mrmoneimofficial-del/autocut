'use client'

/**
 * قصّاص — chunked uploader with progress, ETA, resume, retry.
 * Ported from the مستر منعم production upload system (src/lib/chunked-upload.ts).
 *
 * • 4MB chunks — MUST stay below Vercel's 4.5MB request-body limit (anything
 *   larger is rejected with 413) and MUST match the server's CHUNK_SIZE in
 *   /api/uploads/chunked/init.
 * • Sequential upload — one chunk in flight at a time (keeps the progress bar
 *   strictly monotonic and keeps serverless requests on the same warm instance).
 * • Real progress: within-chunk XHR progress on top of banked chunk bytes —
 *   a retry can rewind the display by at most ONE chunk (4MB), never restart.
 * • Auto retry: 5 attempts per chunk, 1.5s apart, network/5xx only.
 * • Resume: the status endpoint reports chunks already on the server; they are
 *   skipped entirely (wires the documented intent of the reference system) and
 *   a saved sessionId can resume an interrupted upload after a page reload.
 */
import { api } from '@/lib/api-client'

export interface ChunkProgress {
  uploadedBytes: number
  totalBytes: number
  percent: number
  uploadedChunks: number
  totalChunks: number
  /** Bytes/sec across recent chunks */
  speed: number
  /** Seconds remaining, estimated */
  eta: number
  status: 'uploading' | 'merging' | 'done' | 'error' | 'paused'
  error?: string
}

// 4MB — MUST stay below Vercel's 4.5MB request-body limit and MUST match the
// server's CHUNK_SIZE in the chunked init route (3 places, one golden rule).
const SERVER_CHUNK_SIZE = 4 * 1024 * 1024
const MAX_RETRIES = 5
const RETRY_DELAY_MS = 1500

/** Lightweight checksum from the chunk's first/last bytes + length. Good
 *  enough for transport integrity (matches the server's verifyChecksum). */
function quickChecksum(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf)
  const len = view.length
  let h = len
  const sample = (i: number) => (view[i] | 0)
  if (len > 0) h = (h * 31 + sample(0)) >>> 0
  if (len > 1) h = (h * 31 + sample(len - 1)) >>> 0
  if (len > 2) h = (h * 31 + sample(len >> 1)) >>> 0
  if (len > 3) h = (h * 31 + sample(len >> 2)) >>> 0
  return h.toString(16)
}

export interface ChunkedUploadHandle {
  /** Promise that resolves with the final payload when complete */
  done: Promise<any | null>
  /** Latest progress snapshot */
  getProgress: () => ChunkProgress
  /** Cancel the upload */
  cancel: () => void
  /** Pause upload (finishes current chunk) */
  pause: () => void
  /** Resume a paused upload */
  resume: () => void
}

/** A session saved by a previous (interrupted) run of the same file. */
export interface ResumeSession {
  sessionId: string
  fileName: string
  fileSize: number
}

interface UploadOpts {
  /** Base API path for the chunked endpoints, WITHOUT trailing slash.
   *  The uploader appends `/init`, `/{sessionId}/status`,
   *  `/{sessionId}/chunk?index=…&c=…`, and `/{sessionId}/complete`. */
  basePath: string
  file: File
  onProgress: (p: ChunkProgress) => void
  /** Called once the sessionId is established (fresh init OR resumed session) —
   *  lets the caller persist it for cross-reload resume. */
  onSession?: (sessionId: string) => void
  /** Reuse a previous session for this exact file (same name + size). */
  resume?: ResumeSession | null
  signal?: AbortSignal
}

export function createChunkedUpload(opts: UploadOpts): ChunkedUploadHandle {
  const { basePath, file, onProgress } = opts
  const totalBytes = file.size
  const totalChunks = Math.ceil(totalBytes / SERVER_CHUNK_SIZE)

  let uploadedBytes = 0
  let uploadedChunksCount = 0
  let sessionId: string | null = null
  let resumed = false
  let paused = false
  let cancelled = false
  let currentXhr: XMLHttpRequest | null = null
  const chunkTimes: number[] = [] // recent chunk durations for speed estimate

  const progress: ChunkProgress = {
    uploadedBytes: 0,
    totalBytes,
    percent: 0,
    uploadedChunks: 0,
    totalChunks,
    speed: 0,
    eta: 0,
    status: 'uploading',
  }

  const emit = () => {
    progress.uploadedBytes = uploadedBytes
    progress.uploadedChunks = uploadedChunksCount
    progress.percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0
    // Speed: average bytes/sec over recent chunks
    const recent = chunkTimes.slice(-5)
    if (recent.length > 0) {
      const avgMs = recent.reduce((s, x) => s + x, 0) / recent.length
      progress.speed = avgMs > 0 ? (SERVER_CHUNK_SIZE / avgMs) * 1000 : 0
      const remainingBytes = totalBytes - uploadedBytes
      progress.eta = progress.speed > 0 ? Math.ceil(remainingBytes / progress.speed) : 0
    }
    onProgress({ ...progress })
  }

  const uploadChunk = async (index: number): Promise<boolean> => {
    if (cancelled || paused) return false
    const start = index * SERVER_CHUNK_SIZE
    const end = Math.min(start + SERVER_CHUNK_SIZE, totalBytes)
    const blob = file.slice(start, end)
    const buf = await blob.arrayBuffer()
    const checksum = quickChecksum(buf)

    return new Promise<boolean>((resolve) => {
      let attempt = 0
      const tryOnce = () => {
        if (cancelled || paused) {
          resolve(false)
          return
        }
        const xhr = new XMLHttpRequest()
        currentXhr = xhr
        const chunkStart = Date.now()
        xhr.open('POST', `${basePath}/${sessionId}/chunk?index=${index}&c=${checksum}`)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // Within-chunk progress on top of banked bytes — monotonic except
            // for a ≤4MB dip when a failed chunk restarts (by design).
            const partial = uploadedBytes + e.loaded
            progress.uploadedBytes = Math.min(partial, totalBytes)
            progress.percent = Math.round((progress.uploadedBytes / totalBytes) * 100)
            onProgress({ ...progress })
          }
        }
        xhr.onload = () => {
          currentXhr = null
          if (xhr.status >= 200 && xhr.status < 300) {
            const chunkDuration = Date.now() - chunkStart
            chunkTimes.push(chunkDuration)
            uploadedBytes = end
            uploadedChunksCount++
            emit()
            resolve(true)
          } else if (xhr.status === 0 || xhr.status >= 500) {
            // Network/server error — retry
            attempt++
            if (attempt > MAX_RETRIES) {
              progress.status = 'error'
              progress.error = `فشل رفع الجزء ${index + 1} بعد ${MAX_RETRIES} محاولات`
              emit()
              resolve(false)
            } else {
              setTimeout(tryOnce, RETRY_DELAY_MS)
            }
          } else {
            // Client error — don't retry
            let msg = `فشل رفع الجزء ${index + 1} (${xhr.status})`
            try {
              const j = JSON.parse(xhr.responseText)
              if (j.error) msg = j.error
            } catch { /* not JSON */ }
            progress.status = 'error'
            progress.error = msg
            emit()
            resolve(false)
          }
        }
        xhr.onerror = () => {
          currentXhr = null
          attempt++
          if (attempt > MAX_RETRIES) {
            progress.status = 'error'
            progress.error = `انقطاع الاتصال أثناء رفع الجزء ${index + 1}`
            emit()
            resolve(false)
          } else {
            setTimeout(tryOnce, RETRY_DELAY_MS)
          }
        }
        xhr.ontimeout = () => {
          currentXhr = null
          attempt++
          if (attempt > MAX_RETRIES) {
            progress.status = 'error'
            progress.error = `انتهت مهلة الجزء ${index + 1}`
            emit()
            resolve(false)
          } else {
            setTimeout(tryOnce, RETRY_DELAY_MS)
          }
        }
        xhr.timeout = 120000 // 2 min per chunk
        xhr.send(buf)
      }
      tryOnce()
    })
  }

  const done = (async (): Promise<any | null> => {
    try {
      // 1. Init session (or reuse a saved one for this exact file)
      if (opts.resume && opts.resume.fileName === file.name && opts.resume.fileSize === file.size) {
        sessionId = opts.resume.sessionId
      }
      if (sessionId) {
        try {
          await api(`${basePath}/${sessionId}/status`)
          resumed = true // session still alive → continue where it stopped
        } catch {
          sessionId = null // swept/expired → start fresh
        }
      }
      if (!sessionId) {
        const initRes = await api<{ sessionId: string; chunkSize: number; totalChunks: number }>(
          `${basePath}/init`,
          { json: { fileName: file.name, mimeType: file.type, fileSize: file.size } },
        )
        sessionId = initRes.sessionId
      }
      opts.onSession?.(sessionId)

      // 2. Check resume status — which chunks already landed on the server?
      /** chunk indexes that are banked server-side (skip re-sending them) */
      const uploadedSet = new Set<number>()
      if (resumed) {
        const status = await api<{ uploadedChunks: number[]; totalChunks: number }>(
          `${basePath}/${sessionId}/status`,
        )
        for (const i of status.uploadedChunks || []) uploadedSet.add(Number(i))
        for (const i of uploadedSet) {
          uploadedChunksCount++
          uploadedBytes += Math.min(SERVER_CHUNK_SIZE, totalBytes - i * SERVER_CHUNK_SIZE)
        }
        if (uploadedBytes > totalBytes) uploadedBytes = totalBytes
      }
      emit()

      // 3. Upload missing chunks sequentially
      for (let i = 0; i < totalChunks; i++) {
        if (cancelled) return null
        // wait while paused
        while (paused && !cancelled) {
          await new Promise((r) => setTimeout(r, 300))
        }
        if (cancelled) return null
        if (uploadedSet.has(i)) continue // banked on the server — never re-send
        const ok = await uploadChunk(i)
        if (!ok) return null
        uploadedSet.add(i)
      }

      if (cancelled) return null

      // 4. Merge + verify on server
      progress.status = 'merging'
      progress.percent = 100
      emit()

      const completeRes = await api<any>(`${basePath}/${sessionId}/complete`, { json: {} })
      progress.status = 'done'
      emit()
      return completeRes
    } catch (e: any) {
      progress.status = 'error'
      progress.error = e.message || 'فشل الرفع'
      emit()
      return null
    }
  })()

  return {
    done,
    getProgress: () => ({ ...progress }),
    cancel: () => {
      cancelled = true
      if (currentXhr) currentXhr.abort()
      progress.status = 'error'
      progress.error = 'تم الإلغاء'
      emit()
    },
    pause: () => {
      if (!paused && progress.status === 'uploading') {
        paused = true
        progress.status = 'paused'
        emit()
      }
    },
    resume: () => {
      if (paused) {
        paused = false
        progress.status = 'uploading'
        emit()
      }
    },
  }
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '-'
  const mb = bytesPerSec / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} م.ب/ث`
  return `${Math.round(bytesPerSec / 1024)} ك.ب/ث`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-'
  if (seconds < 60) return `${seconds} ث`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m} د ${s} ث`
  const h = Math.floor(m / 60)
  return `${h} س ${m % 60} د`
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 م.ب'
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.round(bytes / 1024)} ك.ب`
  if (mb < 1024) return `${mb.toFixed(1)} م.ب`
  return `${(mb / 1024).toFixed(2)} ج.ب`
}
