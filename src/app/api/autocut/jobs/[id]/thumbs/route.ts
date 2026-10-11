import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ownerTokenFrom, signMediaUrl, verifyMediaSignature } from '@/lib/autocut/auth'
import { getOwnedJob } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { jobDir, originalPath, fileExt } from '@/lib/autocut/paths'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** One filmstrip frame every 10 s — 54 min ≈ 323 thumbs ≈ ~2 MB. */
const THUMB_INTERVAL_MS = 10_000
const THUMB_WIDTH = 160

function thumbsDir(jobId: string): string {
  return path.join(jobDir(jobId), 'thumbs')
}

function countThumbs(jobId: string): number {
  try {
    return fs.readdirSync(thumbsDir(jobId)).filter((f) => f.endsWith('.jpg')).length
  } catch {
    return 0
  }
}

/**
 * Kick off thumbnail generation (idempotent, async). ffmpeg runs detached as a
 * child of the long-lived Next dev server, writing t00001.jpg… + thumbs.done
 * when finished. The client polls ?meta=1 until ready.
 */
function ensureThumbs(jobId: string, input: string, expectedCount: number) {
  const dir = thumbsDir(jobId)
  const doneMarker = path.join(dir, 'thumbs.done')
  const runMarker = path.join(dir, 'thumbs.running')
  if (fs.existsSync(doneMarker) || fs.existsSync(runMarker)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(runMarker, String(Date.now()))
  const log = fs.openSync(path.join(dir, 'thumbs.log'), 'a')
  const child = spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-i', input,
      '-vf', `fps=1/${THUMB_INTERVAL_MS / 1000},scale=${THUMB_WIDTH}:-2`,
      '-q:v', '5',
      path.join(dir, 't%05d.jpg'),
    ],
    { detached: true, stdio: ['ignore', log, log] }
  )
  child.unref()
  child.on('exit', (code) => {
    try {
      fs.unlinkSync(runMarker)
    } catch { /* ignore */ }
    const got = countThumbs(jobId)
    if (code === 0 && got > 0) {
      fs.writeFileSync(doneMarker, JSON.stringify({ count: got, intervalMs: THUMB_INTERVAL_MS }))
    } else if (got >= Math.max(1, expectedCount - 2)) {
      // tolerate a non-zero exit when all frames were still produced
      fs.writeFileSync(doneMarker, JSON.stringify({ count: got, intervalMs: THUMB_INTERVAL_MS }))
    } else {
      fs.appendFileSync(path.join(dir, 'thumbs.log'), `\n[thumbs] exit ${code}, produced ${got}/${expectedCount} — not marking done\n`)
    }
  })
}

/**
 * GET /api/autocut/jobs/:id/thumbs
 *   ?meta=1            → { ready, generating, count, intervalMs, urlTemplate }
 *   ?i=N&exp=&sig=     → the Nth filmstrip JPEG (signed; <img> cannot send headers)
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const url = new URL(req.url)

    // ---- image serving -----------------------------------------------------
    if (url.searchParams.has('i')) {
      const sigOk = verifyMediaSignature(id, 'thumbs', Number(url.searchParams.get('exp')), url.searchParams.get('sig'))
      if (!sigOk) {
        return Response.json({ code: 'BAD_SIGNATURE', message: 'Invalid or expired media link.' }, { status: 403 })
      }
      const i = Number(url.searchParams.get('i'))
      if (!Number.isInteger(i) || i < 0 || i > 100000) {
        return Response.json({ code: 'BAD_REQUEST', message: 'Bad thumb index.' }, { status: 400 })
      }
      const file = path.join(thumbsDir(id), `t${String(i + 1).padStart(5, '0')}.jpg`)
      if (!fs.existsSync(file)) {
        return Response.json({ code: 'NOT_FOUND', message: 'Thumb not generated (yet).' }, { status: 404 })
      }
      const buf = fs.readFileSync(file)
      return new Response(new Uint8Array(buf), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=86400',
          'Content-Length': String(buf.length),
        },
      })
    }

    // ---- meta / generation trigger -----------------------------------------
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()

    const durationMs = (() => {
      try {
        return JSON.parse(row.metaJson ?? '{}').durationMs ?? 0
      } catch {
        return 0
      }
    })()
    const expected = Math.max(1, Math.ceil(durationMs / THUMB_INTERVAL_MS))
    const doneMarker = path.join(thumbsDir(id), 'thumbs.done')
    const runMarker = path.join(thumbsDir(id), 'thumbs.running')
    const ready = fs.existsSync(doneMarker)
    const generating = fs.existsSync(runMarker)

    if (!ready && !generating && row.status !== 'uploading') {
      const input = originalPath(row.id, fileExt(row.filename))
      if (fs.existsSync(input)) ensureThumbs(row.id, input, expected)
    }

    const count = ready ? countThumbs(id) : countThumbs(id)
    const signed = signMediaUrl(row.id, 'thumbs')
    const base = signed.includes('?') ? `${signed}&` : `${signed}?`
    return Response.json({
      ready,
      generating: fs.existsSync(runMarker),
      count,
      expected,
      intervalMs: THUMB_INTERVAL_MS,
      urlTemplate: `${base}i={i}`,
    })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] thumbs error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
