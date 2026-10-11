import { db } from '@/lib/db'
import { ownerTokenFrom, newJobId } from '@/lib/autocut/auth'
import { jobToDTO, isAcceptedFile } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { STORAGE_ROOT, jobDir, originalPath, fileExt } from '@/lib/autocut/paths'
import { availableDiskBytes } from '@/lib/autocut/disk'
import fs from 'node:fs'

export const dynamic = 'force-dynamic'

function jsonError(e: unknown): Response {
  if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
  console.error('[autocut] internal error:', e)
  const fallback = ERR.internal()
  return Response.json(fallback.toJSON(), { status: fallback.httpStatus })
}

/** GET /api/autocut/jobs — list the studio's jobs (for resume/restore).
 * Single-user mode: every job is listed regardless of which session token
 * created it, so projects stay visible across browsers and devices. */
export async function GET(req: Request) {
  try {
    const token = ownerTokenFrom(req)
    if (!token) throw ERR.missingToken()
    const rows = await db.autoCutJob.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 24,
    })
    return Response.json({ jobs: rows.map(jobToDTO) })
  } catch (e) {
    return jsonError(e)
  }
}

/**
 * POST /api/autocut/jobs — initialize a resumable chunked upload.
 * Body: { filename, size, mime }
 */
export async function POST(req: Request) {
  try {
    const token = ownerTokenFrom(req)
    if (!token) throw ERR.missingToken()
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new AutoCutError('BAD_REQUEST', 'Invalid request body.')
    const filename = String((body as any).filename ?? '').slice(0, 255)
    const size = Number((body as any).size ?? 0)
    const mime = String((body as any).mime ?? 'video/mp4').slice(0, 100)
    const smart = !!(body as any)?.smart
    if (!filename) throw new AutoCutError('BAD_REQUEST', 'A filename is required.')

    const problem = isAcceptedFile(filename, mime, size)
    if (problem) throw new AutoCutError('UNSUPPORTED_FORMAT', problem, undefined, 422)

    // Storage budget: original + rendered output + segment workspace.
    const avail = availableDiskBytes(STORAGE_ROOT)
    if (avail != null && avail < size * 2.2 + 500 * 1024 * 1024) {
      throw ERR.storageFull(size * 2.2 / 1024 / 1024, avail / 1024 / 1024)
    }

    const id = newJobId()
    const dir = jobDir(id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(originalPath(id, fileExt(filename)), Buffer.alloc(0))

    const row = await db.autoCutJob.create({
      data: {
        id,
        ownerToken: token,
        filename,
        mime,
        sizeBytes: String(Math.round(size)),
        status: 'uploading',
        stage: 'upload',
        stageMessage: 'Uploading…',
        progress: 0,
        ...(smart ? { smartJson: JSON.stringify({ enabled: true }) } : {}),
      },
    })
    return Response.json({ job: jobToDTO(row), chunkSize: 16 * 1024 * 1024 })
  } catch (e) {
    return jsonError(e)
  }
}
