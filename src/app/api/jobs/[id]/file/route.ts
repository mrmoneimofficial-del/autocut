import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')
const CHUNK_STATE = 'chunks.json'

type Ctx = { params: Promise<{ id: string }> }
type Interval = [number, number]

const jobDirOf = (id: string) => path.join(ROOT, id)

function readJob(id: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, id, 'job.json'), 'utf8')) } catch { return null }
}

function atomicWriteJSON(file: string, data: unknown) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

/**
 * Upload coverage map — which byte ranges of the target file are already on disk.
 * Chunks may arrive in ANY order and in PARALLEL lanes; the map is a merged,
 * sorted interval list. State lives in chunks.json and is the single source of
 * truth for progress + resume. Legacy sequential uploads (job.uploaded) are
 * migrated transparently on first touch.
 */
function loadCoverage(id: string, size: number): { size: number; intervals: Interval[] } {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(jobDirOf(id), CHUNK_STATE), 'utf8'))
    if (d && typeof d.size === 'number' && Array.isArray(d.intervals)) return d
  } catch { /* fresh upload */ }
  const job = readJob(id)
  const up = Math.min(Number(job?.uploaded) || 0, size)
  return { size, intervals: up > 0 ? [[0, up]] : [] }
}

function addInterval(list: Interval[], s: number, e: number): Interval[] {
  let ns = s, ne = e
  const out: Interval[] = []
  for (const iv of list) {
    const [a, b] = iv
    if (b < ns || a > ne) { out.push(iv); continue } // disjoint
    ns = Math.min(ns, a); ne = Math.max(ne, b)       // overlap/adjacent → extend
  }
  out.push([ns, ne])
  out.sort((x, y) => x[0] - y[0])
  return out
}

const coveredBytes = (list: Interval[]) => list.reduce((n, [s, e]) => n + (e - s), 0)

/**
 * PUT /api/jobs/:id/file?offset=N — write ONE upload chunk at byte offset N.
 * Parallel + out-of-order safe. Optional X-Chunk-SHA256 integrity check.
 * All fs work is synchronous → atomic within this process; chunks.json is
 * written tmp+rename so a crash can never leave torn state on disk.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const job = readJob(id)
  if (!job) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (job.phase !== 'uploading' && job.phase !== 'uploaded') {
    return Response.json({ error: 'الرفع خلص خلاص', uploaded: job.size, complete: true }, { status: 409 })
  }

  const url = new URL(req.url)
  const offset = Number(url.searchParams.get('offset'))
  if (!Number.isFinite(offset) || offset < 0 || Math.floor(offset) !== offset) {
    return Response.json({ error: 'offset غير صالح' }, { status: 400 })
  }

  const buf = Buffer.from(await req.arrayBuffer())
  if (buf.length === 0) return Response.json({ error: 'chunk فاضي' }, { status: 400 })
  if (offset + buf.length > job.size) return Response.json({ error: 'الجزء خارج حجم الملف' }, { status: 400 })

  // per-chunk integrity — catches any corruption mid-flight (proxy, memory, disk)
  const want = req.headers.get('x-chunk-sha256')
  if (want) {
    const got = crypto.createHash('sha256').update(buf).digest('hex')
    if (got !== want.toLowerCase()) return Response.json({ error: 'CHUNK_CORRUPT' }, { status: 422 })
  }

  const file = path.join(jobDirOf(id), 'original' + job.ext)
  try {
    // 'r+' keeps existing bytes; 'w+' only creates the (empty) file on first touch
    const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+')
    try { fs.writeSync(fd, buf, 0, buf.length, offset) } finally { fs.closeSync(fd) }
  } catch (e) {
    console.error('[upload] write error:', e)
    return Response.json({ error: 'فشل كتابة الجزء — جرّب تاني' }, { status: 500 })
  }

  // bookkeeping
  const cov = loadCoverage(id, job.size)
  cov.intervals = addInterval(cov.intervals, offset, offset + buf.length)
  const uploaded = coveredBytes(cov.intervals)
  const complete = uploaded >= job.size
  atomicWriteJSON(path.join(jobDirOf(id), CHUNK_STATE), cov)

  if (complete) {
    let diskOk = true
    try { diskOk = fs.statSync(file).size === job.size } catch { diskOk = false }
    if (!diskOk) {
      // paranoid guard: coverage says full but disk disagrees → reset map, client re-uploads
      atomicWriteJSON(path.join(jobDirOf(id), CHUNK_STATE), { size: job.size, intervals: [] })
      return Response.json({ error: 'الملف على القرص ناقص — هنرفع الجزء الناقص' }, { status: 500 })
    }
    job.uploaded = job.size
    job.phase = 'uploaded'
    atomicWriteJSON(path.join(ROOT, id, 'job.json'), job)
    return Response.json({ uploaded: job.size, complete: true })
  }

  return Response.json({ uploaded, complete: false })
}

/** GET /api/jobs/:id/file?v=src|out[&dl=1] — Range-capable video streaming. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  const job = readJob(id)
  if (!job) return new Response('Not Found', { status: 404 })

  const url = new URL(req.url)
  const v = url.searchParams.get('v') === 'out' ? 'out' : 'src'
  // out.mp4 exists from phase 'mirroring' (mirror upload runs after render) —
  // the UI offers download/preview during that bonus phase
  if (v === 'out' && job.phase !== 'done' && job.phase !== 'mirroring') return new Response('Not Found', { status: 404 })
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
