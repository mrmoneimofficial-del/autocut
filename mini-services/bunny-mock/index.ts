/**
 * Bunny.net Storage API mock — تطوير واختبار محليين فقط
 *
 * The sandbox has no Bunny account, so local E2E tests of the مستر منعم
 * upload system run against this look-alike instead. It implements exactly
 * the surface the app uses (storage.bunnycdn.com shapes):
 *
 *   PUT    /:zone/:path   (AccessKey write)      → 201 Created
 *   GET    /:zone/:path   (AccessKey read)       → bytes (+ Range → 206)
 *   HEAD   /:zone/:path                          → headers
 *   DELETE /:zone/:path                          → 200
 *   GET    /:zone/:dir/                          → JSON [{ObjectName, Length,
 *                                                    IsDirectory, ContentType}]
 *
 * Point the app at it with:
 *   BUNNY_STORAGE_ZONE=qattaas
 *   BUNNY_STORAGE_PASSWORD=test-key
 *   BUNNY_STORAGE_READ_PASSWORD=test-key
 *   BUNNY_STORAGE_HOST=http://localhost:3041
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = 3041
const ZONE = 'qattaas'
const WRITE_KEY = 'test-key'
const READ_KEY = 'test-key'
const DATA = path.join(import.meta.dir, '.data')

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  json: 'application/json', txt: 'text/plain',
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const clean = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    // /:zone/rest…
    const parts = clean.split('/')
    if (parts[0] !== ZONE || parts.length < 2) {
      return new Response('not found', { status: 404 })
    }
    const rest = parts.slice(1).join('/')

    // AccessKey header check (write ops need WRITE_KEY, reads need READ_KEY)
    const key = req.headers.get('accesskey') || ''
    const mayRead = key === READ_KEY || key === WRITE_KEY
    const mayWrite = key === WRITE_KEY

    // ---- directory listing: GET /:zone/:dir/ (trailing slash) ----
    if (req.method === 'GET' && (url.pathname.endsWith('/') || rest === '')) {
      if (!mayRead) return new Response('401 Unauthorized', { status: 401 })
      const dir = path.join(DATA, ZONE, rest)
      const out: any[] = []
      try {
        for (const name of fs.readdirSync(dir)) {
          const st = fs.statSync(path.join(dir, name))
          if (st.isDirectory()) out.push({ ObjectName: name, IsDirectory: true, Length: 0, ContentType: '' })
          else out.push({
            ObjectName: name,
            IsDirectory: false,
            Length: st.size,
            ContentType: MIME[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream',
          })
        }
      } catch { /* missing dir → empty list (real Bunny 404s; empty is friendlier for probes) */ }
      return Response.json(out)
    }

    const file = path.join(DATA, ZONE, rest)
    // path traversal guard
    if (!file.startsWith(path.join(DATA, ZONE))) return new Response('bad path', { status: 400 })

    // ---- write ----
    if (req.method === 'PUT') {
      if (!mayWrite) return new Response('401 Unauthorized', { status: 401 })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const buf = Buffer.from(await req.arrayBuffer())
      fs.writeFileSync(file, buf)
      return new Response(`{"status":"ok","path":"${rest}"}`, {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ---- delete ----
    if (req.method === 'DELETE') {
      if (!mayWrite) return new Response('401 Unauthorized', { status: 401 })
      try { fs.rmSync(file); return new Response('200 OK', { status: 200 }) } catch { return new Response('404 Not Found', { status: 404 }) }
    }

    // ---- read / head ----
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!mayRead) return new Response('401 Unauthorized', { status: 401 })
      let st: fs.Stats
      try { st = fs.statSync(file) } catch { return new Response('404 Not Found', { status: 404 }) }
      const type = MIME[rest.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream'
      const baseHeaders: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'ETag': `"${crypto.createHash('sha1').update(rest).digest('hex')}"`,
      }

      const range = req.headers.get('range')
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/)
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0
          let end = m[2] ? parseInt(m[2], 10) : st.size - 1
          if (start >= st.size || start > end) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } })
          }
          end = Math.min(end, st.size - 1)
          const slice = st.size > 0 && req.method === 'GET'
            ? new Response(Bun.file(file).slice(start, end + 1))
            : new Response(null)
          const h = new Headers(slice.headers)
          h.set('Content-Type', type)
          h.set('Content-Range', `bytes ${start}-${end}/${st.size}`)
          h.set('Content-Length', String(end - start + 1))
          h.set('Accept-Ranges', 'bytes')
          return new Response(slice.status === 200 && req.method === 'GET' ? Bun.file(file).slice(start, end + 1) : null, {
            status: 206,
            headers: h,
          })
        }
      }
      const headers = new Headers(baseHeaders)
      headers.set('Content-Length', String(st.size))
      if (req.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(Bun.file(file), { status: 200, headers })
    }

    return new Response('method not allowed', { status: 405 })
  },
})

console.log(`[bunny-mock] Bunny Storage look-alike on :${PORT} (zone=${ZONE}, data=${DATA})`)
