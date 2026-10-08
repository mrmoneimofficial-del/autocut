'use client'

/**
 * قصّاص — upload helper with real progress (XHR-based).
 * Ported from the مستر منعم src/lib/upload.ts (token plumbing dropped —
 * قصّاص is a public tool). fetch can't report upload progress; XHR can.
 */

export interface UploadProgress {
  loaded: number
  total: number
  percent: number
}

export interface UploadOptions {
  url: string
  formData: FormData
  /** HTTP method (default: 'POST'). */
  method?: string
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
}

/** Upload a FormData via XHR to get real upload progress events.
 *  Returns the parsed JSON response. Throws on non-2xx. */
export function uploadWithProgress<T = any>(opts: UploadOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(opts.method || 'POST', opts.url)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) {
        opts.onProgress({
          loaded: e.loaded,
          total: e.total,
          percent: Math.round((e.loaded / e.total) * 100),
        })
      }
    }

    xhr.upload.onerror = () => reject(new Error('فشل الاتصال أثناء الرفع'))
    xhr.upload.ontimeout = () => reject(new Error('انتهت مهلة الرفع'))

    xhr.onload = () => {
      let data: any = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = xhr.responseText
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T)
      } else {
        const msg = (data && data.error) || `فشل الرفع (${xhr.status})`
        reject(new Error(msg))
      }
    }

    xhr.onerror = () => reject(new Error('فشل الرفع'))
    xhr.timeout = 0 // no XHR timeout; rely on server

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(Object.assign(new Error('تم إلغاء الرفع'), { name: 'CancelError' }))
        return
      }
      opts.signal.addEventListener('abort', () => {
        xhr.abort()
        reject(Object.assign(new Error('تم إلغاء الرفع'), { name: 'CancelError' }))
      }, { once: true })
    }

    xhr.send(opts.formData)
  })
}
