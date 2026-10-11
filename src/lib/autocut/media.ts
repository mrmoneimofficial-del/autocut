import fs from 'node:fs'
import { Readable } from 'node:stream'

/**
 * HTTP media serving with full Range support — required so the browser can
 * seek inside multi-hour videos while only buffering what it plays.
 */
export function serveMediaFile(req: Request, filePath: string, contentType: string, downloadName?: string): Response {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return Response.json({ code: 'NOT_FOUND', message: 'Media file not found.' }, { status: 404 })
  }
  const size = stat.size
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  }
  if (downloadName) {
    // RFC 5987: ASCII-safe fallback + UTF-8 filename* so Arabic (and any
    // non-ASCII) download names survive instead of collapsing to "_".
    const safe = downloadName.replace(/[^\w.\- ]/g, '_')
    const encoded = encodeURIComponent(downloadName).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    baseHeaders['Content-Disposition'] = `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`
  }

  const rangeHeader = req.headers.get('range')
  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    if (m) {
      const startStr = m[1]
      const endStr = m[2]
      let start = startStr ? Number(startStr) : 0
      let end = endStr ? Number(endStr) : size - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        })
      }
      const stream = fs.createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }
  }

  const stream = fs.createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) },
  })
}
