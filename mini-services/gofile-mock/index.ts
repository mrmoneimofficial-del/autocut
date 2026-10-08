/**
 * GoFile API mock — تطوير واختبار محليين فقط
 *
 * The sandbox IP is DDoS-blocked by gofile.io, so local E2E tests of cloud
 * mode run against this look-alike instead. It implements exactly the surface
 * the app uses, matching the official API shapes (Oct 2026 docs):
 *
 *   POST /accounts                         → guest account {token}
 *   GET  /servers                          → {servers:[{name:'localhost:PORT'…}]}
 *   POST /uploadfile   (+/contents/uploadfile legacy path)
 *        multipart: file[, token, folderId]→ upload payload {id, guestToken,
 *                                            parentFolder, downloadPage, servers…}
 *   GET  /contents/:id  (Bearer or ?wt=)   → {status,data:{link,…}}
 *   GET  /download/web/:fileId/:fileName   → the raw bytes
 *
 * Point the app at it with:
 *   GOFILE_API=http://localhost:3040
 *   GOFILE_UPLOAD_BASE=http://localhost:3040/uploadfile
 *   GOFILE_STORE_BASE=http://localhost:3040
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = 3040
const DATA = path.join(import.meta.dir, '.data')
fs.mkdirSync(DATA, { recursive: true })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } })
const rand = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n).replace(/[^A-Za-z0-9]/g, 'x')

type Meta = {
  id: string
  name: string
  size: number
  mimetype: string
  parentFolder: string
  parentFolderCode: string
  downloadPage: string
  code: string
  createTime: number
}

const metaFile = (id: string) => path.join(DATA, `${id}.meta.json`)
const binFile = (id: string) => path.join(DATA, `${id}.bin`)
const foldersFile = path.join(DATA, 'folders.json')
function readMeta(id: string): Meta | null {
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')) } catch { return null }
}
/** folder id → share code (mirrors gofile: same folder = same download page) */
function folderCodeOf(folderId: string | null): { id: string; code: string } {
  let map: Record<string, string> = {}
  try { map = JSON.parse(fs.readFileSync(foldersFile, 'utf8')) } catch { /* fresh */ }
  if (folderId && map[folderId]) return { id: folderId, code: map[folderId] }
  const id = folderId || `mock-folder-${rand(8)}`
  const code = rand(8)
  map[id] = code
  try { fs.writeFileSync(foldersFile, JSON.stringify(map)) } catch { /* best-effort */ }
  return { id, code }
}

async function handleUpload(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return json({ status: 'error-field' }, 400)
  const folderId = String(form?.get('folderId') || '')
  const token = String(form?.get('token') || '')

  const id = crypto.randomUUID()
  const buf = Buffer.from(await file.arrayBuffer())
  fs.writeFileSync(binFile(id), buf)
  const folder = folderCodeOf(folderId || null)
  const code = rand(8)
  const meta: Meta = {
    id,
    name: file.name,
    size: buf.length,
    mimetype: file.type || 'application/octet-stream',
    parentFolder: folder.id,
    parentFolderCode: folder.code,
    downloadPage: `https://gofile.io/d/${folder.code}`,
    code,
    createTime: Math.floor(Date.now() / 1000),
  }
  fs.writeFileSync(metaFile(id), JSON.stringify(meta))
  return json({
    status: 'ok',
    data: {
      id,
      type: 'file',
      name: meta.name,
      parentFolder: meta.parentFolder,
      parentFolderCode: meta.parentFolderCode,
      downloadPage: meta.downloadPage,
      code: meta.code,
      size: meta.size,
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      mimetype: meta.mimetype,
      createTime: meta.createTime,
      modTime: meta.createTime,
      servers: ['localhost:3040'],
      ...(!token ? { guestToken: `mock-guest-${rand(16)}` } : {}),
    },
  })
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    // ---- upload (both the new fleet path and the legacy per-server path) ----
    if (req.method === 'POST' && (url.pathname === '/uploadfile' || url.pathname === '/contents/uploadfile')) {
      return handleUpload(req)
    }

    // ---- guest account ----
    if (req.method === 'POST' && url.pathname === '/accounts') {
      return json({ status: 'ok', data: { token: `mock-${rand(20)}`, rootFolder: 'mock-root', tier: 'guest' } })
    }

    // ---- server list (the ':' makes the app treat it as an absolute origin) ----
    if (req.method === 'GET' && url.pathname === '/servers') {
      return json({ status: 'ok', data: { servers: [{ name: `localhost:${PORT}`, zone: 'mock' }] } })
    }

    // ---- content metadata ----
    const m = url.pathname.match(/^\/contents\/([A-Za-z0-9-]+)$/)
    if (req.method === 'GET' && m) {
      const meta = readMeta(m[1])
      if (!meta) return json({ status: 'error-notFound' }, 404)
      return json({
        status: 'ok',
        data: {
          id: meta.id, type: 'file', name: meta.name, size: meta.size, code: meta.code,
          parentFolder: meta.parentFolder, isOwner: true,
          link: `http://localhost:${PORT}/download/web/${meta.id}/${encodeURIComponent(meta.name)}`,
        },
      })
    }

    // ---- raw download ----
    const d = url.pathname.match(/^\/download\/web\/([A-Za-z0-9-]+)\/(.+)$/)
    if (req.method === 'GET' && d) {
      const meta = readMeta(d[1])
      if (!meta || !fs.existsSync(binFile(meta.id))) return new Response('not found', { status: 404, headers: CORS })
      const buf = fs.readFileSync(binFile(meta.id))
      return new Response(buf, {
        headers: {
          'Content-Type': meta.mimetype,
          'Content-Length': String(buf.length),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          ...CORS,
        },
      })
    }

    return json({ status: 'error-notFound' }, 404)
  },
})

console.log(`[gofile-mock] GoFile look-alike on http://localhost:${PORT} (data: ${DATA})`)
