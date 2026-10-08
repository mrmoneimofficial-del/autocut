/**
 * قصّاص — Bunny.net Storage Layer
 *
 * Adapted verbatim from the مستر منعم upload system (production reference):
 * drop-in storage backend that works identically on a local server and on
 * Vercel serverless. Every uploaded original + every cut result lives in a
 * Bunny Storage zone; delivery goes through short-lived signed tokens
 * (src/lib/storage-auth.ts) streamed by /api/uploads/stream.
 *
 * Env:
 *   BUNNY_STORAGE_ZONE          — storage zone name
 *   BUNNY_STORAGE_PASSWORD      — write AccessKey
 *   BUNNY_STORAGE_READ_PASSWORD — read AccessKey (falls back to the write key)
 *   BUNNY_STORAGE_HOST          — override endpoint (default storage.bunnycdn.com;
 *                                 used by the local bunny-mock for E2E tests)
 */

const ZONE = process.env.BUNNY_STORAGE_ZONE || 'qattaas'
const PASSWORD = process.env.BUNNY_STORAGE_PASSWORD || ''
const READ_PASSWORD = process.env.BUNNY_STORAGE_READ_PASSWORD || PASSWORD
// Global Bunny endpoint. Regional endpoints have DNS issues from some
// networks; the global endpoint routes to the nearest region automatically.
const HOST = (process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const BASE = process.env.BUNNY_STORAGE_HOST?.startsWith('http')
  ? `${process.env.BUNNY_STORAGE_HOST.replace(/\/+$/, '')}/${ZONE}`
  : `https://${HOST}/${ZONE}`

/** Is the zone configured (write key present)? Drives probe/degradation. */
export function bunnyConfigured(): boolean {
  return Boolean(PASSWORD && ZONE)
}

/** Full URL to an object in the Bunny zone. */
export function bunnyUrl(remotePath: string): string {
  const clean = remotePath.replace(/^\/+/, '')
  return `${BASE}/${clean}`
}

/** Authenticated headers (write/delete operations). */
function writeHeaders(): HeadersInit {
  return {
    AccessKey: PASSWORD,
    'Content-Type': 'application/octet-stream',
  }
}

/** Read headers (download operations — read-only password). Exposed for
 *  the cloud-cut's direct download (downloadToFile needs them too). */
export function bunnyReadHeaders(): Record<string, string> {
  return { AccessKey: READ_PASSWORD }
}

/**
 * Upload a file (Buffer) to Bunny storage.
 * @param remotePath path inside the zone, e.g. "uploads/<sid>/original.mp4"
 * @param data file content
 * @returns public URL of the uploaded file
 */
export async function bunnyUpload(
  remotePath: string,
  data: Buffer | ArrayBuffer | Uint8Array,
): Promise<string> {
  const url = bunnyUrl(remotePath)
  const body = data instanceof Buffer ? data : Buffer.from(data)
  const res = await fetch(url, {
    method: 'PUT',
    headers: writeHeaders(),
    body: new Uint8Array(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`فشل رفع الملف على تخزين Bunny (${res.status}): ${text.slice(0, 180)}`)
  }
  return url
}

/**
 * Download a file from Bunny storage.
 * @param remotePath path inside the zone
 * @returns Buffer of the file content, or null if not found
 */
export async function bunnyDownload(remotePath: string): Promise<Buffer | null> {
  const url = bunnyUrl(remotePath)
  const res = await fetch(url, { headers: bunnyReadHeaders() })
  if (!res.ok) return null
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

/** Get a file's metadata (size, type, exists) without downloading content. */
export async function bunnyStat(remotePath: string): Promise<{
  exists: boolean
  size: number
  contentType: string
} | null> {
  const url = bunnyUrl(remotePath)
  const res = await fetch(url, { method: 'HEAD', headers: bunnyReadHeaders() })
  if (!res.ok) return null
  return {
    exists: true,
    size: Number(res.headers.get('content-length') || 0),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  }
}

/** Delete a file from Bunny storage. Silent no-op if the file doesn't exist. */
export async function bunnyDelete(remotePath: string): Promise<void> {
  const url = bunnyUrl(remotePath)
  try {
    await fetch(url, { method: 'DELETE', headers: writeHeaders() })
  } catch {
    /* non-critical */
  }
}

/**
 * List files in a directory inside the Bunny zone.
 * Bunny LIST endpoint: GET https://storage.bunnycdn.com/{zone}/{path}/ — must
 * end with a trailing slash, returns a JSON array.
 */
export async function bunnyList(dirPath: string): Promise<Array<{
  name: string
  size: number
  isDirectory: boolean
  contentType: string
}>> {
  const clean = dirPath.replace(/^\/+/, '').replace(/\/+$/, '')
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`
  const url = `${base}${clean}/`
  const res = await fetch(url, { headers: bunnyReadHeaders() })
  if (!res.ok) return []
  const data = (await res.json().catch(() => [])) as Array<any>
  return (data || []).map((x) => ({
    name: String(x.ObjectName || ''),
    size: Number(x.Length || 0),
    isDirectory: !!x.IsDirectory,
    contentType: String(x.ContentType || ''),
  }))
}

/**
 * Stream-proxy a file from Bunny to the client. Sets the right Content-Type
 * and Content-Range headers. Bunny honors Range requests so browsers can seek.
 */
export async function bunnyStream(
  remotePath: string,
  rangeHeader?: string | null,
): Promise<Response> {
  const url = bunnyUrl(remotePath)
  const headers: HeadersInit = { ...bunnyReadHeaders() }
  if (rangeHeader) {
    ;(headers as Record<string, string>)['Range'] = rangeHeader
  }
  const upstream = await fetch(url, { headers })
  if (!upstream.ok && upstream.status !== 206) {
    return new Response('Not found', { status: 404 })
  }
  const respHeaders = new Headers()
  for (const k of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
  ]) {
    const v = upstream.headers.get(k)
    if (v) respHeaders.set(k, v)
  }
  if (!respHeaders.has('accept-ranges')) respHeaders.set('accept-ranges', 'bytes')
  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  })
}

/** Detect MIME type from a filename extension. */
export function mimeFromExt(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    json: 'application/json',
    txt: 'text/plain',
    html: 'text/html',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * Storage-agnostic path helpers (قصّاص flavor of the reference StoragePaths).
 * The "remote path" is the path inside the Bunny zone — always rooted at
 * `uploads/<sessionId>/…` so every file of one upload session lives together
 * (original + all re-cut results), mirroring the old same-folder behaviour.
 */
export const StoragePaths = {
  sessionDir: (sessionId: string) => `uploads/${sessionId}`,
  original: (sessionId: string, safeName: string) => `uploads/${sessionId}/${safeName}`,
  result: (sessionId: string, stamp: string) => `uploads/${sessionId}/result-${stamp}.mp4`,
}
