'use client'

/**
 * قصّاص — tiny fetch helper for client → API (adapted from the مستر منعم
 * api-client.ts; the admin/student token plumbing is dropped because قصّاص
 * is a public tool — everything else is identical).
 */

export async function api<T = any>(
  path: string,
  options?: RequestInit & { json?: any; formData?: FormData },
): Promise<T> {
  const init: RequestInit = { ...options }
  // Remove custom props that fetch doesn't understand
  delete (init as any).json
  delete (init as any).formData
  const headers: Record<string, string> = {}

  if (options?.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.json)
    init.method = init.method || 'POST'
  } else if (options?.formData) {
    init.body = options.formData
    init.method = init.method || 'POST'
    // Do NOT set Content-Type — browser sets it with boundary for FormData
  }

  init.headers = { ...headers, ...((options?.headers as Record<string, string>) || {}) }
  init.credentials = 'same-origin'

  const res = await fetch(path, init)
  const text = await res.text()
  let data: any = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const msg = (data && data.error) || `حدث خطأ (${res.status})`
    const err = new Error(msg) as any
    err.status = res.status
    err.data = data
    throw err
  }
  return data as T
}
