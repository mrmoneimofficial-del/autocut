import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')

type Ctx = { params: Promise<{ id: string }> }

function jobDirOf(id: string) { return path.join(ROOT, id) }

function readJob(id: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, id, 'job.json'), 'utf8')) } catch { return null }
}

/** PUT /api/jobs/:id/file?offset=N — append one upload chunk (raw body). */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const job = readJob(id)
  if (!job) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (job.phase !== 'uploading' && job.phase !== 'uploaded') {
    return Response.json({ error: 'الرفع خلص خلاص' }, { status: 409 })
  }

  const url = new URL(req.url)
  const offset = Number(url.searchParams.get('offset'))
  if (!Number.isFinite(offset) || offset < 0) return Response.json({ error: 'offset غير صالح' }, { status: 400 })
  if (offset !== job.uploaded) return Response.json({ error: 'OFFSET_MISMATCH', uploaded: job.uploaded }, { status: 409 })

  const buf = Buffer.from(await req.arrayBuffer())
  if (buf.length === 0) return Response.json({ error: 'chunk فاضي' }, { status: 400 })

  const file = path.join(jobDirOf(id), 'original' + job.ext)
  try {
    const fd = fs.openSync(file, job.uploaded === 0 ? 'w' : 'r+')
    fs.writeSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
  } catch (e) {
    console.error('[upload] write error:', e)
    return Response.json({ error: 'فشل كتابة الجزء — جرّب تاني' }, { status: 500 })
  }

  job.uploaded = offset + buf.length
  const complete = job.uploaded >= job.size
  if (complete) job.phase = 'uploaded'
  fs.writeFileSync(path.join(ROOT, id, 'job.json'), JSON.stringify(job))
  return Response.json({ uploaded: job.uploaded, complete })
}

/** GET /api/jobs/:id/file?v=src|out[&dl=1] — Range-capable video streaming. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  const job = readJob(id)
  if (!job) return new Response('Not Found', { status: 404 })

  const url = new URL(req.url)
  const v = url.searchParams.get('v') === 'out' ? 'out' : 'src'
  if (v === 'out' && job.phase !== 'done') return new Response('Not Found', { status: 404 })
  const file = path.join(jobDirOf(id), v === 'out' ? 'out.mp4' : 'original' + job.ext)
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
