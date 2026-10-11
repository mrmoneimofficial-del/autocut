'use client'

/**
 * Resumable chunked uploader — tuned for cloud-gateway realities.
 *
 * - XHR (not fetch): `upload.onprogress` gives byte-level progress, so the UI
 *   moves from the first kilobyte instead of after a whole chunk.
 * - PARALLEL streams: up to 3 chunks in flight at once on separate byte
 *   windows — multiplies throughput on slow/throttling proxies where a single
 *   connection never exceeds ~1 MB/s no matter how big the body is.
 * - Adaptive chunk size: starts small (1 MB) to prove the path, doubles on
 *   success up to 16 MB and halves on failure (min 512 KB). Body-size limits
 *   self-heal. Server writes are idempotent per byte-window, so parallel
 *   windows and retransmissions are all safe.
 * - Stall watchdog: an attempt with zero byte movement for 20 s is aborted
 *   and retried — a black-holed connection can never hang the UI forever.
 * - Resyncs to the server's durable offset after a 409 (crash/restart safe).
 */

export interface UploaderCallbacks {
  onProgress: (info: { sentBytes: number; totalBytes: number; speedBps: number }) => void
  onStateChange: (state: 'uploading' | 'paused' | 'done' | 'error' | 'canceled') => void
  onError?: (message: string) => void
}

const START_CHUNK = 1 * 1024 * 1024 // first chunk is small → visible progress in ~1 s
const MAX_CHUNK = 16 * 1024 * 1024 // ceiling once the path is proven
const MIN_CHUNK = 512 * 1024 // floor when shrinking after failures
const STALL_MS = 20_000 // no byte movement for this long → abort + retry
const HARD_TIMEOUT_MS = 10 * 60_000 // absolute backstop per attempt
const MAX_RETRIES = 6
const PARALLEL = 3 // concurrent chunk streams (separate byte windows)

export class ChunkedUploader {
  private file: File
  private jobId: string
  private cb: UploaderCallbacks
  private offset = 0 // next byte to SCHEDULE (windows may still be in flight)
  private acked = 0 // highest byte confirmed by the server (contiguous)
  private paused = false
  private canceled = false
  private running = false
  private speed = 0
  private chunkSize = START_CHUNK
  private growDelay = 0
  private xhrs = new Set<XMLHttpRequest>()

  constructor(file: File, jobId: string, cb: UploaderCallbacks) {
    this.file = file
    this.jobId = jobId
    this.cb = cb
  }

  setServerOffset(offset: number) {
    this.offset = offset
    this.acked = offset
  }

  pause() {
    this.paused = true
    // abort the in-flight attempts; the already-ACKed prefix is on the server
    // and each unfinished window is re-sent (overwrite) from its start on resume.
    for (const xhr of this.xhrs) xhr.abort()
    this.cb.onStateChange('paused')
  }

  resume() {
    if (!this.running) {
      this.paused = false
      this.speed = 0
      void this.run()
    }
  }

  get isPaused() {
    return this.paused
  }

  cancel() {
    this.canceled = true
    for (const xhr of this.xhrs) xhr.abort()
    this.cb.onStateChange('canceled')
  }

  private report(total: number) {
    // UI progress = contiguous confirmed prefix + bytes buffered in sockets
    this.cb.onProgress({ sentBytes: Math.min(total, this.maxSeen), totalBytes: total, speedBps: this.speed })
  }

  private get maxSeen() {
    return Math.max(this.acked, ...Array.from(this.inflight.values(), (w) => w.start + w.loaded))
  }

  private inflight = new Map<XMLHttpRequest, { start: number; end: number; loaded: number }>()

  /**
   * Sends one chunk via XHR. Resolves with the server's authoritative
   * `received` byte count. Rejects with:
   *  - `{ resync: true, serverSize }` → caller jumps to the server offset
   *  - `{ fatal: true, message }`     → stop retrying, surface to the user
   *  - anything else                  → retryable
   */
  private sendChunk(offset: number, blob: Blob): Promise<{ received: number }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      this.xhrs.add(xhr)
      this.inflight.set(xhr, { start: offset, end: offset + blob.size, loaded: 0 })
      xhr.open('POST', `/api/autocut/jobs/${this.jobId}/upload/chunk?offset=${offset}`)
      xhr.setRequestHeader('x-owner-token', localStorage.getItem('autocut-owner-token') ?? '')
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.timeout = HARD_TIMEOUT_MS

      let lastMovement = Date.now()
      let prevSpeedTime = Date.now()
      let prevSpeedLoaded = 0
      let stallAborted = false

      // Stall watchdog: zero byte movement for STALL_MS → abort + retry.
      const watchdog = setInterval(() => {
        if (Date.now() - lastMovement > STALL_MS) {
          stallAborted = true
          xhr.abort()
        }
      }, 1000)

      const finish = (fn: () => void) => {
        clearInterval(watchdog)
        this.xhrs.delete(xhr)
        this.inflight.delete(xhr)
        fn()
      }

      xhr.upload.onprogress = (ev) => {
        const w = this.inflight.get(xhr)
        if (w) w.loaded = ev.loaded
        if (ev.loaded > 0) lastMovement = Date.now()
        const now = Date.now()
        const dt = now - prevSpeedTime
        if (dt >= 250 && ev.loaded > prevSpeedLoaded) {
          const inst = ((ev.loaded - prevSpeedLoaded) * 1000) / dt
          this.speed = this.speed > 0 ? this.speed * 0.6 + inst * 0.4 : inst
          prevSpeedTime = now
          prevSpeedLoaded = ev.loaded
        }
        // live progress: confirmed prefix + everything in sockets
        this.cb.onProgress({ sentBytes: Math.min(this.file.size, this.maxSeen), totalBytes: this.file.size, speedBps: this.speed })
      }

      xhr.onload = () => {
        finish(() => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const j = JSON.parse(xhr.responseText)
              resolve({ received: Number(j.received ?? offset + blob.size) })
            } catch {
              resolve({ received: offset + blob.size })
            }
          } else if (xhr.status === 409) {
            // server offset is authoritative — resync (single-stream fallback)
            try {
              const j = JSON.parse(xhr.responseText)
              const serverSize = Number(j?.diskSize ?? 0)
              if (Number.isFinite(serverSize)) {
                reject(Object.assign(new Error('resync'), { resync: true, serverSize }))
              } else {
                reject(new Error('Upload offset mismatch. Try resuming again.'))
              }
            } catch {
              reject(new Error('Upload offset mismatch. Try resuming again.'))
            }
          } else if (xhr.status === 401 || xhr.status === 403 || xhr.status === 404 || xhr.status === 422) {
            let message = `Upload rejected (${xhr.status}).`
            try {
              const j = JSON.parse(xhr.responseText)
              if (j?.message) message = j.message
            } catch {}
            reject(Object.assign(new Error(message), { fatal: true }))
          } else if (xhr.status === 413) {
            // somewhere in the chain this body is too large → shrink and retry
            reject(Object.assign(new Error('Chunk too large for the gateway — retrying smaller.'), { shrink: true }))
          } else {
            let message = `Upload chunk failed (${xhr.status}).`
            try {
              const j = JSON.parse(xhr.responseText)
              if (j?.message) message = j.message
            } catch {}
            reject(new Error(message))
          }
        })
      }

      xhr.onerror = () => {
        finish(() => reject(new Error('Network error while uploading.')))
      }

      xhr.ontimeout = () => {
        finish(() => reject(new Error('The upload request timed out.')))
      }

      xhr.onabort = () => {
        finish(() => {
          if (stallAborted) {
            reject(Object.assign(new Error('Connection stalled — retrying.'), { shrink: true }))
          } else if (this.canceled) {
            reject(Object.assign(new Error('canceled'), { canceled: true }))
          } else if (this.paused) {
            reject(Object.assign(new Error('paused'), { paused: true }))
          } else {
            reject(new Error('The upload was interrupted.'))
          }
        })
      }

      xhr.send(blob)
    })
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.paused = false
    this.canceled = false
    this.cb.onStateChange('uploading')
    const total = this.file.size
    let errCount = 0

    try {
      // ---- parallel window scheduler -------------------------------------
      // Windows are handed out sequentially; up to PARALLEL are in flight at
      // once. `acked` only advances over a CONTIGUOUS confirmed prefix —
      // progress, resume offsets and 409-resyncs stay well-defined.
      let resync = false
      let serverSize = 0

      const workerLoop = async (lane: number): Promise<void> => {
        for (;;) {
          if (this.canceled || this.paused) return
          if (resync && lane !== 0) return // single-stream resync mode
          if (this.offset >= total && !resync) return

          const start = this.offset
          if (resync) {
            // resync lane: adopt the server's authoritative contiguous size
            this.offset = this.acked = serverSize
            resync = false
            if (this.acked >= total) return
            continue
          }
          const end = Math.min(total, start + this.chunkSize)
          this.offset = end // window claimed
          const blob = this.file.slice(start, end)
          try {
            await this.sendChunk(start, blob)
            this.acked = Math.max(this.acked, end)
            errCount = 0
            // path proven → grow the chunk, but wait out the anti-oscillation
            // delay after a stall (prevents 16 MB stall → 8 MB ok → 16 MB …)
            if (this.growDelay > 0) this.growDelay--
            else this.chunkSize = Math.min(MAX_CHUNK, this.chunkSize * 2)
            this.report(total)
          } catch (e: any) {
            if (this.canceled) return
            if (e?.resync) {
              serverSize = Number(e.serverSize ?? this.acked)
              resync = true
              this.report(total)
              continue
            }
            if (e?.paused) return
            if (e?.fatal) throw e
            // retryable: shrink and let the loop re-send this same window
            this.offset = start
            this.chunkSize = Math.max(MIN_CHUNK, Math.floor(this.chunkSize / 2))
            if (e?.shrink) this.growDelay = 6
            errCount++
            if (errCount >= MAX_RETRIES) throw e
            await new Promise((r) => setTimeout(r, Math.min(5000, 700 * errCount)))
          }
        }
      }

      await Promise.all(Array.from({ length: PARALLEL }, (_, i) => workerLoop(i)))

      if (this.canceled || this.paused) {
        this.running = false
        return
      }
      this.cb.onStateChange('done')
      this.cb.onProgress({ sentBytes: total, totalBytes: total, speedBps: this.speed })
    } catch (e: any) {
      if (!this.canceled && !this.paused) {
        this.cb.onStateChange('error')
        this.cb.onError?.(e?.message ?? 'The upload failed.')
      }
    } finally {
      this.running = false
    }
  }
}
