'use client'

/**
 * قصّاص — SHARED upload workflow hook.
 * Ported from the مستر منعم src/hooks/use-upload.ts (single source of truth
 * for the upload DECISION logic): files ≥4MB go through the chunked pipeline
 * (progress %, speed, ETA, pause/resume/cancel, retry, resume); smaller files
 * use one simple XHR request. Both paths surface their progress through the
 * shared UploadProgressCard.
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

/** 4MB threshold — files at/above this use the chunked pipeline. A single
 *  request body MUST stay below Vercel's 4.5MB limit (413 above that), so
 *  both the threshold AND the chunk size are 4MB. MUST match the server's
 *  CHUNK_SIZE in /api/uploads/chunked/init. */
const CHUNK_THRESHOLD = 4 * 1024 * 1024

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

    // ── Large files (≥4MB): chunked uploader with resume ──
    if (file.size >= CHUNK_THRESHOLD) {
      setChunkProgress({
        uploadedBytes: 0,
        totalBytes: file.size,
        percent: 0,
        uploadedChunks: 0,
        totalChunks: Math.ceil(file.size / (4 * 1024 * 1024)),
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

    // ── Small files (<4MB): simple single-request upload with progress ──
    setSimpleProgress({ loaded: 0, total: file.size, percent: 0 })
    const ac = new AbortController()
    simpleAbortRef.current = ac
    try {
      const fd = new FormData()
      fd.append('file', file, file.name)
      const data = await uploadWithProgress<T>({
        url: opts.url || `${basePath}/simple`,
        formData: fd,
        signal: ac.signal,
        onProgress: (p) => setSimpleProgress(p),
      })
      onDone?.(data)
      return data
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
