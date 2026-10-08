'use client'

/**
 * قصّاص — SHARED upload workflow hook.
 * Ported from the مستر منعم src/hooks/use-upload.ts (single source of truth
 * for the upload DECISION logic). v2: the bar is set VERY low (256KB) —
 * essentially every real video goes through the adaptive chunked pipeline
 * (immune to proxy body caps / timeouts), and only tiny files use the one
 * simple XHR request (with retries). Both paths surface their progress
 * through the shared UploadProgressCard.
 */
import { useCallback, useRef, useState } from 'react'
import { uploadWithProgress } from '@/lib/upload'
import {
  createChunkedUpload,
  type ChunkProgress,
  type ChunkedUploadHandle,
  type ResumeSession,
} from '@/lib/chunked-upload'
import type { SimpleUploadProgress } from '@/components/upload-progress-card'

/**
 * Files below this use the simple single-request path; anything bigger uses
 * the adaptive chunked pipeline. A single request body MUST stay below
 * Vercel's 4.5MB limit — 256KB is safely under ANY hostile proxy too.
 */
const CHUNK_THRESHOLD = 256 * 1024

export interface UploadResult<T = any> {
  data: T
}

interface UploadParams<T = any> {
  file: File
  /** Base API path for chunked uploads (no trailing slash). */
  basePath: string
  /** URL for the SIMPLE (non-chunked) upload — the file is appended as
   *  FormData field "file". Defaults to `<basePath>/simple`. */
  url?: string
  /** A session saved by an interrupted run of the same file (resume). */
  resume?: ResumeSession | null
  /** Called with the chunked session id once established (persist for resume). */
  onSession?: (sessionId: string) => void
  /** Called with the parsed JSON response on success. */
  onDone?: (data: T) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function useUpload() {
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [chunkProgress, setChunkProgress] = useState<ChunkProgress | null>(null)
  const [simpleProgress, setSimpleProgress] = useState<SimpleUploadProgress | null>(null)
  const chunkHandleRef = useRef<ChunkedUploadHandle | null>(null)
  const simpleAbortRef = useRef<AbortController | null>(null)

  const upload = useCallback(async <T = any>(opts: UploadParams<T>): Promise<T | null> => {
    const { file, basePath, resume, onSession, onDone } = opts
    setUploading(true)
    setFileName(file.name)

    // ── Real videos (≥256KB): adaptive chunked uploader with resume ──
    if (file.size >= CHUNK_THRESHOLD) {
      setChunkProgress({
        uploadedBytes: 0,
        bankedBytes: 0,
        totalBytes: file.size,
        percent: 0,
        chunkSize: 256 * 1024,
        speed: 0,
        eta: 0,
        status: 'uploading',
      })
      const handle = createChunkedUpload({
        basePath,
        file,
        resume,
        onSession,
        onProgress: (p) => setChunkProgress(p),
      })
      chunkHandleRef.current = handle
      try {
        const result = await handle.done
        if (result) {
          const data = result as unknown as T
          onDone?.(data)
          return data
        }
        return null
      } finally {
        setUploading(false)
        setChunkProgress(null)
        setFileName('')
        chunkHandleRef.current = null
      }
    }

    // ── Tiny files (<256KB): simple single-request upload (3 attempts) ──
    setSimpleProgress({ loaded: 0, total: file.size, percent: 0 })
    const ac = new AbortController()
    simpleAbortRef.current = ac
    try {
      const fd = new FormData()
      fd.append('file', file, file.name)
      const url = opts.url || `${basePath}/simple`
      let lastErr: any = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const data = await uploadWithProgress<T>({
            url,
            formData: fd,
            signal: ac.signal,
            onProgress: (p) => setSimpleProgress(p),
          })
          onDone?.(data)
          return data
        } catch (e: any) {
          if (e?.name === 'CancelError' || ac.signal.aborted) return null
          lastErr = e
          if (attempt < 3) await sleep(1000 * attempt)
        }
      }
      throw lastErr || new Error('فشل الرفع')
    } finally {
      setUploading(false)
      setSimpleProgress(null)
      setFileName('')
      simpleAbortRef.current = null
    }
  }, [])

  /** Cancel a simple (non-chunked) upload in flight. */
  const cancelSimple = useCallback(() => {
    simpleAbortRef.current?.abort()
  }, [])

  return {
    upload,
    uploading,
    fileName,
    chunkProgress,
    simpleProgress,
    chunkHandle: chunkHandleRef,
    cancelSimple,
  }
}
