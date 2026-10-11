import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { verifyPathToken } from '@/lib/storage-auth'
import { bunnyConfigured, bunnyStream, mimeFromExt } from '@/lib/bunny-storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * GET /api/uploads/stream?t=<signed-token>[&dl=1]
 *
 * Signed-token delivery for everything in Bunny Storage (originals + results),
 * ported from the مستر منعم stream route: verify the HMAC token → stream with
 * Range support (seek works) → force the right content type.
 * قصّاص flips the reference's protection model: ?dl=1 sets an attachment
 * disposition (the user WANTS to download their cut), the default is inline
 * (in-browser preview).
 *
 * v2 — local warm tier: when Bunny is not configured (or the object is not on
 * it), serve from this function's warm /tmp instead — the no-Bunny path stays
 * fully usable end-to-end (upload → cut → download) on a single warm instance:
 *   • uploads/<sid>/original.<ext>  →  /tmp/uploads/<sid>/merged.bin
 *     (the complete route keeps it precisely for this when Bunny is off)
 *   • uploads/<sid>/result-*.mp4    →  /tmp/qattaas-cloud/<sha256(original)>/out.mp4
 *     (the cut route's job dir — jobId = sha256(originalPath).slice(0,32))
 */

const UPLOADS_DIR = '/tmp/uploads'
const CLOUD_ROOT = path.join(os.tmpdir(), 'qattaas-cloud')
const EXTS = ['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts']

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p) } catch { return null }
}

/** map a signed Bunny-style path to a warm local file, if one exists */
function localCandidateFor(remotePath: string): string | null {
  const m = remotePath.match(/^uploads\/([a-f0-9]{24})\/(.+)$/)
  if (!m) return null
  const [, sid, name] = m
  // original → the upload session's merged.bin (kept by complete when !bunnyOK)
  if (/^original\.[a-z0-9]+$/i.test(name)) {
    const merged = path.join(UPLOADS_DIR, sid, 'merged.bin')
    if (safeStat(merged)?.isFile()) return merged
    return null
  }
  // result → the cut job's out.mp4; jobId = sha256(originalPath).slice(0,32)
  // (the original's ext is unknown from a result token, so probe each ext)
  if (/^result-.*\.mp4$/i.test(name)) {
    for (const ext of EXTS) {
      const jobId = crypto.createHash('sha256').update(`uploads/${sid}/original${ext}`).digest('hex').slice(0, 32)
      const out = path.join(CLOUD_ROOT, jobId, 'out.mp4')
      if (safeStat(out)?.isFile()) return out
    }
    return null
  }
  return null
}

/** serve a local file with Range support (206 + content-range), streamed */
function localFileResponse(
  file: string,
  rangeHeader: string | null,
  contentType: string,
  disposition: string,
): Response {
  const size = fs.statSync(file).size
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  })

  let start = 0
  let end = size - 1
  let status = 200
  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Math.max(0, Math.min(size - 1, Number(m[1])))
        if (m[2]) end = Math.max(start, Math.min(size - 1, Number(m[2])))
      } else {
        // suffix form: bytes=-N → the last N bytes
        const n = Math.max(1, Math.min(size, Number(m[2])))
        start = size - n
        end = size - 1
      }
      status = 206
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }
  }
  headers.set('Content-Length', String(end - start + 1))

  const nodeStream = fs.createReadStream(file, { start, end })
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  return new Response(webStream, { status, headers })
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('t')
  const claims = verifyPathToken(token)
  if (!claims) {
    return new Response('الرابط ده انتهى أو مش صالح — قصّ الفيديو تاني عشان تاخد لينك جديد', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const contentType = mimeFromExt(claims.path)
  const base = claims.path.split('/').pop() || 'qattaas.mp4'
  const nice = base.startsWith('result-')
    ? `قصّاص-${base.replace(/^result-/, '').replace(/\.mp4$/i, '')}.mp4`
    : 'قصّاص-الفيديو-الأصلي.mp4'
  const disposition = url.searchParams.get('dl') === '1'
    ? `attachment; filename*=UTF-8''${encodeURIComponent(nice)}`
    : 'inline'

  // ---- tier 1: Bunny Storage (only when actually configured) ----
  if (bunnyConfigured()) {
    const upstream = await bunnyStream(claims.path, req.headers.get('range'))
    if (upstream.status !== 404) {
      const headers = new Headers(upstream.headers)
      // sane content type (Bunny sometimes answers octet-stream)
      const ct = headers.get('content-type')
      if (!ct || ct === 'application/octet-stream') headers.set('Content-Type', contentType)
      headers.set('Content-Disposition', disposition)
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Accept-Ranges', 'bytes')
      return new Response(upstream.body, { status: upstream.status, headers })
    }
    // not on Bunny → try the local warm tier below
  }

  // ---- tier 2: this function's warm /tmp (no-Bunny mode / Bunny hiccup) ----
  const local = localCandidateFor(claims.path)
  if (local) {
    return localFileResponse(local, req.headers.get('range'), contentType, disposition)
  }

  const where = bunnyConfigured() ? 'التخزين السحابي' : 'التخزين السحابي (مش متظبط على السيرفر ده)'
  return new Response(`الملف مش موجود على ${where}`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
