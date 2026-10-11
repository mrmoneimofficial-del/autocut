import { ownerTokenFrom, verifyMediaSignature } from '@/lib/autocut/auth'
import { getOwnedJob, safeJsonParse } from '@/lib/autocut/job'
import { ERR, AutoCutError } from '@/lib/autocut/errors'
import { envelopePath } from '@/lib/autocut/paths'
import { parseEnvelope, bucketEnvelope } from '@/lib/autocut/envelope'
import fs from 'node:fs'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/autocut/jobs/:id/envelope?start=0&end=60000&buckets=2000
 * Display-ready waveform buckets for a zoom window. The full envelope never
 * leaves the server; only the requested view is aggregated — so a 4-hour
 * video costs the same as a 5-minute one on the wire.
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const url = new URL(req.url)
    // auth: owner token (header or query) OR a valid media signature
    const sigOk = verifyMediaSignature(id, 'stream', Number(url.searchParams.get('exp')), url.searchParams.get('sig'))
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row && !sigOk) throw ERR.jobNotFound()
    const envFile = envelopePath(id)
    if (!fs.existsSync(envFile)) {
      throw new AutoCutError('NO_DETECTION', 'Waveform data is not available yet.', undefined, 409)
    }
    const env = parseEnvelope(fs.readFileSync(envFile))
    const totalMs = env.frames * env.frameMs
    const start = Math.max(0, Number(url.searchParams.get('start') ?? 0) || 0)
    const end = Math.min(totalMs, Number(url.searchParams.get('end') ?? totalMs) || totalMs)
    const buckets = Math.max(50, Math.min(20000, Number(url.searchParams.get('buckets') ?? 2048) || 2048))
    const { min, max } = bucketEnvelope(env, start, end, buckets)
    return Response.json({
      startMs: start,
      endMs: end,
      frameMs: env.frameMs,
      buckets: min.length,
      min,
      max,
    })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] envelope error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
