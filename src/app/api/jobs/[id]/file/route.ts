import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/jobs/:id/file?v=src|out[&dl=1] — Range-capable local video
 * streaming for the server-mode workbench (source preview + result preview).
 * (Uploads no longer go through this route — the مستر منعم chunked system at
 * /api/uploads/chunked/* owns uploading now.)
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  const jobDir = path.join(ROOT, id)
  let job: Record<string, any> | null = null
  try { job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8')) } catch { /* missing */ }
  if (!job) return new Response('Not Found', { status: 404 })

  const url = new URL(req.url)
  const v = url.searchParams.get('v') === 'out' ? 'out' : 'src'
  // out.mp4 exists from phase 'mirroring' (storage upload runs after render) —
  // the UI offers download/preview during that bonus phase
  if (v === 'out' && job.phase !== 'done' && job.phase !== 'mirroring') return new Response('Not Found', { status: 404 })
  const file = path.join(jobDir, v === 'out' ? 'out.mp4' : 'original' + job.ext)
  if (!fs.existsSync(file)) return new Response('Not Found', { status: 404 })

  const size = fs.statSync(file).size
  const range = req.headers.get('range')
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  if (url.searchParams.get('dl') === '1') {
    const safe = (job.name || 'video.mp4').replace(/[^\p{L}\p{N}._ -]/gu, '_')
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`)
  }

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : size - 1
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      end = Math.min(end, size - 1)
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(end - start + 1))
      const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream
      return new Response(stream, { status: 206, headers })
    }
  }
  headers.set('Content-Length', String(size))
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream
  return new Response(stream, { status: 200, headers })
}
