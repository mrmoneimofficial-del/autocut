'use client'

/**
 * قصّاص — chunked uploader with progress, ETA, resume, retry.
 * Ported from the مستر منعم production upload system (src/lib/chunked-upload.ts),
 * hardened into v2 after the "progress bar restarts from scratch" incident:
 *
 * ROOT CAUSE (found in the wild): the preview gateway in front of the app
 * KILLS request bodies it considers too big/slow. A fixed-4MB chunk POST
 * dies mid-flight over and over — the browser's within-chunk progress climbs
 * to ~20%, the request is killed, nothing is banked, the bar rewinds to 0
 * and the same 4MB chunk is re-sent forever. ("بيحمل قطعة واحدة ويبدأ من الأول")
 *
 * THE FIX — adaptive chunks (TCP congestion-control style):
 * • Chunks start SMALL (256KB) — small enough to pass any sane proxy cap and
 *   fast enough (≈2.5s at 0.1MB/s) to beat any sane proxy timeout.
 * • Every success GROWS the chunk ×2 (up to 4MB = Vercel's 4.5MB body cap
 *   minus margin) → fast links are just as efficient as before.
 * • Every failure SHRINKS ×2 (floor 64KB) and lowers the growth ceiling →
 *   the uploader automatically converges to the largest size the network
 *   actually lets through, whatever the mystery limit is.
 * • Byte-range protocol (`?start=&len=`): the server banks landed RANGES, so
 *   any byte that ever reached the server is NEVER re-sent (status resync
 *   after every failure + on resume).
 * • STRICT MONOTONIC DISPLAY: a high-water mark on the progress bar — it can
 *   stay flat while a killed chunk is re-sent, but it can NEVER go backwards.
 * • Sequential upload — one chunk in flight (keeps serverless requests on
 *   the same warm instance and makes the bar deterministic).
 */
import { api } from '@/lib/api-client'

export interface ChunkProgress {
  /** DISPLAY bytes — high-water mark, NEVER rewinds */
  uploadedBytes: number
  /** server-confirmed bytes (may lag the display during a killed chunk) */
  bankedBytes: number
  totalBytes: number
  /** monotonic 0..100 */
  percent: number
  /** current adaptive chunk size (bytes) — shown in the UI as transparency */
  chunkSize: number
  /** Bytes/sec over a sliding window of recent chunks */
  speed: number
  /** Seconds remaining, estimated */
  eta: number
  status: 'uploading' | 'retrying' | 'merging' | 'done' | 'error' | 'paused'
  error?: string
}

// Adaptive sizing (must respect the server's MAX_CHUNK_BODY = 4MB).
const MIN_CHUNK = 64 * 1024
const MAX_CHUNK = 4 * 1024 * 1024
const INITIAL_CHUNK = 256 * 1024
const MAX_ATTEMPTS = 6          // consecutive failures at the same cursor → hard error
const XHR_TIMEOUT_MS = 90_000   // generous; slow links send small chunks
const MAX_BACKOFF_MS = 8_000
/** consecutive successes needed before the growth ceiling recovers ×2 —
 *  keeps a hard proxy cap from being re-probed too often while letting a
 *  transient outage stop punishing throughput forever */
const CEILING_RECOVERY_STREAK = 16

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

/** one landed byte range [start, end) — mirrors the server's coverage */
interface Range { start: number; end: number }

interface UploadOpts {
  /** Base API path for the chunked endpoints, WITHOUT trailing slash.
   *  The uploader appends `/init`, `/{sessionId}/status`,
   *  `/{sessionId}/chunk?start=…&len=…&c=…`, and `/{sessionId}/complete`. */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** first byte NOT covered by the (possibly sparse) coverage set */
function firstGap(coverage: Range[]): number {
  let cursor = 0
  for (const r of [...coverage].sort((a, b) => a.start - b.start)) {
    if (r.start > cursor) break
    cursor = Math.max(cursor, r.end)
  }
  return cursor
}

function rangeCovered(coverage: Range[], start: number, end: number): boolean {
  let s = start
  for (const r of [...coverage].sort((a, b) => a.start - b.start)) {
    if (r.start > s) break
    if (r.end > s) s = r.end
    if (s >= end) return true
  }
  return s >= end
}

/** retryable transport failure (network reset / 5xx / timeout) */
class RetryableError extends Error {}
/** hard stop — message surfaces to the user */
class FatalUploadError extends Error {}
/** the serverless instance behind the connection changed and knows nothing
 *  about our session — the attempt-restarter re-inits and pushes again */
class SessionLostError extends Error {}
/** how many times a lost session may be transparently re-established */
const MAX_SESSION_LOSSES = 5
/** silent cancel — the session stays on the server for resume */
class CancelledError extends Error {
  constructor() { super('تم الإلغاء'); this.name = 'CancelledError' }
}

export function createChunkedUpload(opts: UploadOpts): ChunkedUploadHandle {
  const { basePath, file, onProgress } = opts
  const totalBytes = file.size

  // ---- mutable upload state ----
  let sessionId: string | null = null
  let cancelled = false
  let paused = false
  let finished = false
  let currentXhr: XMLHttpRequest | null = null
  let banked = 0 // server-confirmed bytes
  let coverage: Range[] = []
  let chunkSize = INITIAL_CHUNK
  let ceiling = MAX_CHUNK // growth cap (lowered after each failure)
  let successStreak = 0 // drives ceiling recovery after sustained success
  let hwm = 0 // DISPLAY high-water mark — the bar NEVER goes below this

  // sliding speed window: [bytes, ms] per recently-completed chunk
  const speedWindow: Array<[number, number]> = []

  const progress: ChunkProgress = {
    uploadedBytes: 0,
    bankedBytes: 0,
    totalBytes,
    percent: 0,
    chunkSize,
    speed: 0,
    eta: 0,
    status: 'uploading',
  }

  let lastEmit = 0
  const emit = (force = true) => {
    const now = Date.now()
    if (!force && now - lastEmit < 80) return // throttle React churn
    lastEmit = now
    progress.uploadedBytes = Math.min(hwm, totalBytes)
    progress.bankedBytes = banked
    progress.chunkSize = chunkSize
    progress.percent = totalBytes > 0
      ? Math.min(100, Math.floor((hwm / totalBytes) * 100))
      : 0
    const recent = speedWindow.slice(-8)
    if (recent.length > 0) {
      const bytes = recent.reduce((s, x) => s + x[0], 0)
      const ms = recent.reduce((s, x) => s + x[1], 0)
      progress.speed = ms > 0 ? (bytes / ms) * 1000 : 0
      progress.eta = progress.speed > 0 ? Math.ceil((totalBytes - hwm) / progress.speed) : 0
    }
    onProgress({ ...progress })
  }

  /** authoritative resync with the server — banked bytes are never re-sent */
  const resync = async () => {
    let st: { bankedBytes?: number; coverage?: Range[]; complete?: boolean }
    try {
      st = await api<{ bankedBytes?: number; coverage?: Range[]; complete?: boolean }>(
        `${basePath}/${sessionId}/status`,
      )
    } catch (e: any) {
      // 404 = this instance never saw the session (serverless scale-out /
      // connection moved) — let the attempt-restarter rebuild it
      if (e?.status === 404) throw new SessionLostError('الجلسة مش موجودة على الطرف الحالي')
      throw e
    }
    if (typeof st.bankedBytes === 'number') banked = st.bankedBytes
    if (Array.isArray(st.coverage)) coverage = st.coverage
    if (banked > hwm) hwm = banked // confirmed progress lifts the floor…
    // …but the display NEVER drops below what the user already saw.
    return st
  }

  /**
   * Send ONE byte-range. Resolves with the server's fresh coverage.
   * Throws RetryableError on transport failures, FatalUploadError otherwise.
   */
  const sendRange = (start: number, len: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (cancelled || paused) {
        reject(new FatalUploadError('__paused__'))
        return
      }
      const blob = file.slice(start, start + len)
      blob.arrayBuffer().then((buf) => {
        if (cancelled) { reject(new FatalUploadError('__cancelled__')); return }
        const checksum = quickChecksum(buf)
        const xhr = new XMLHttpRequest()
        currentXhr = xhr
        const t0 = Date.now()
        let sentHigh = 0
        xhr.open('POST', `${basePath}/${sessionId}/chunk?start=${start}&len=${len}&c=${checksum}`)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.loaded > sentHigh) {
            sentHigh = e.loaded
            // within-chunk progress on top of banked bytes, high-water clamped
            const shown = banked + e.loaded
            if (shown > hwm) hwm = Math.min(shown, totalBytes)
            progress.status = paused ? 'paused' : 'uploading'
            emit(false)
          }
        }
        xhr.timeout = XHR_TIMEOUT_MS
        const done = (fn: () => void) => { if (currentXhr === xhr) currentXhr = null; fn() }

        xhr.onload = () => done(() => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const j = JSON.parse(xhr.responseText)
              if (typeof j.bankedBytes === 'number') banked = j.bankedBytes
              if (Array.isArray(j.coverage)) coverage = j.coverage
            } catch { /* body unparseable — resync will fix */ }
            const dt = Date.now() - t0
            speedWindow.push([len, Math.max(1, dt)])
            if (banked > hwm) hwm = Math.min(banked, totalBytes)
            resolve()
          } else if (xhr.status === 0 || xhr.status >= 500) {
            reject(new RetryableError(`السيرفر رد ${xhr.status}`))
          } else if (xhr.status === 409) {
            // overlap → resync coverage and let the loop re-target the gap
            try {
              const j = JSON.parse(xhr.responseText)
              if (Array.isArray(j.coverage)) coverage = j.coverage
              if (typeof j.bankedBytes === 'number') banked = j.bankedBytes
            } catch { /* ignore */ }
            resolve() // treated as success-with-resync: the loop recomputes cursor
          } else if (xhr.status === 404) {
            reject(new SessionLostError('الجلسة مش موجودة على الطرف الحالي'))
          } else {
            let msg = `فشل رفع الجزء (${xhr.status})`
            try {
              const j = JSON.parse(xhr.responseText)
              if (j.error) msg = j.error
            } catch { /* not JSON */ }
            reject(new FatalUploadError(msg))
          }
        })
        xhr.onerror = () => done(() => reject(new RetryableError('انقطاع الاتصال')))
        xhr.ontimeout = () => done(() => reject(new RetryableError('انتهت مهلة الجزء')))
        xhr.onabort = () => done(() => reject(new CancelledError()))
        xhr.send(buf)
      }).catch(() => reject(new RetryableError('فشل قراءة الملف محليًا')))
    })
  }

  /** one full attempt: establish session → push missing bytes → merge on the
   *  server. `fresh` skips the resume shortcut (the saved session was lost). */
  const runUpload = async (fresh: boolean): Promise<any | null> => {
    { // bare block keeps the historic indentation of the ported body
      // 1. Establish the session (reuse a saved one for this exact file)
      if (!fresh && opts.resume && opts.resume.fileName === file.name && opts.resume.fileSize === file.size) {
        sessionId = opts.resume.sessionId
        try {
          await resync() // session alive → continue where it stopped
        } catch {
          sessionId = null // swept/expired → start fresh
        }
      }
      if (!sessionId) {
        const initRes = await api<{ sessionId: string }>(`${basePath}/init`, {
          json: { fileName: file.name, mimeType: file.type, fileSize: file.size },
        })
        sessionId = initRes.sessionId
        banked = 0
        coverage = []
      }
      opts.onSession?.(sessionId)

      // 2. Authoritative start point: first byte the server does NOT have
      await resync()
      let cursor = firstGap(coverage)
      hwm = Math.max(hwm, banked)
      emit()

      // 3. Upload the missing bytes sequentially, adapting the chunk size
      let attempts = 0
      while (cursor < totalBytes) {
        if (cancelled) return null
        while (paused && !cancelled) await sleep(250)
        if (cancelled) return null

        const len = Math.min(chunkSize, totalBytes - cursor)
        if (rangeCovered(coverage, cursor, cursor + len)) {
          cursor = firstGap(coverage) // already banked — skip (resume case)
          continue
        }

        try {
          await sendRange(cursor, len)
          attempts = 0
          cursor = firstGap(coverage) // server coverage is the truth
          // grow toward the ceiling after each success
          chunkSize = Math.min(ceiling, chunkSize * 2)
          // after a long clean streak, let the ceiling recover too — a proxy
          // that killed big chunks once shouldn't cap throughput forever
          successStreak++
          if (successStreak >= CEILING_RECOVERY_STREAK && ceiling < MAX_CHUNK) {
            ceiling = Math.min(MAX_CHUNK, ceiling * 2)
            successStreak = 0
          }
          progress.status = 'uploading'
          emit()
        } catch (e) {
          if (e instanceof SessionLostError) throw e // restart via the attempt wrapper
          if (e instanceof FatalUploadError) {
            if (e.message === '__cancelled__' || e.message === '__paused__') return null
            throw e
          }
          // RetryableError → shrink, backoff, resync, retry
          attempts++
          if (attempts >= MAX_ATTEMPTS) {
            throw new FatalUploadError(
              'الاتصال بيفصل الطلبات بشكل متكرر — لو انت على شبكة ضعيفة استنى شوية وجرّب تاني، أو جرّب شبكة تانية',
            )
          }
          chunkSize = Math.max(MIN_CHUNK, Math.floor(chunkSize / 2))
          ceiling = Math.min(ceiling, chunkSize) // never grow past a failing size this run
          successStreak = 0
          progress.status = 'retrying'
          emit()
          await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1)))
          if (cancelled) return null
          while (paused && !cancelled) await sleep(250)
          if (cancelled) return null
          await resync() // whatever landed is banked forever — continue from the gap
          cursor = firstGap(coverage)
          hwm = Math.max(hwm, banked)
          emit()
        }
      }

      if (cancelled) return null

      // 4. Merge + verify on server
      progress.status = 'merging'
      hwm = totalBytes
      emit()

      let completeRes: any
      try {
        completeRes = await api<any>(`${basePath}/${sessionId}/complete`, { json: {} })
      } catch (e: any) {
        if (e?.status === 404) throw new SessionLostError('الجلسة مش موجودة على الطرف الحالي')
        throw e
      }
      finished = true
      progress.status = 'done'
      emit()
      return completeRes
    }
  }

  const done = (async (): Promise<any | null> => {
    try {
      let losses = 0
      for (;;) {
        try {
          return await runUpload(losses > 0)
        } catch (e) {
          if (e instanceof SessionLostError && !cancelled && ++losses <= MAX_SESSION_LOSSES) {
            // the connection landed on a different serverless instance —
            // rebuild the session and push everything again (the display
            // bar never rewinds, so this is invisible apart from a short
            // "retrying" blip)
            sessionId = null
            banked = 0
            coverage = []
            chunkSize = INITIAL_CHUNK
            ceiling = MAX_CHUNK
            successStreak = 0
            progress.status = 'retrying'
            progress.error = 'الرفع اتنقل لطرف سيرفر تاني — بنعيد التأسيس تلقائيًا'
            emit()
            await sleep(1500)
            continue
          }
          throw e
        }
      }
    } catch (e: any) {
      if (cancelled) return null
      progress.status = 'error'
      progress.error = e?.message || 'فشل الرفع'
      emit()
      // surface the failure to the caller (the banner + retry button) — a
      // resolve(null) here used to race the caller's ref-update effect and
      // the error vanished silently (found in browser E2E).
      if (e?.name === 'CancelledError' || cancelled) return null
      throw e instanceof Error ? e : new Error(e?.message || 'فشل الرفع')
    }
  })()

  return {
    done,
    getProgress: () => ({ ...progress }),
    cancel: () => {
      cancelled = true
      if (currentXhr) currentXhr.abort()
      if (!finished) {
        progress.status = 'error'
        progress.error = 'تم الإلغاء'
        emit()
      }
    },
    pause: () => {
      if (!paused && (progress.status === 'uploading' || progress.status === 'retrying')) {
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
