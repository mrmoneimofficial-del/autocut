import fs from 'node:fs'
import path from 'node:path'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { STORAGE_ROOT } from '@/lib/autocut/paths'
import type { TranscriptFile } from '@/lib/autocut/types'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/autocut/jobs/:id/transcript — the per-sentence transcript produced
 * by the smart pass (ASR + AI verdicts), powering the text-based editor.
 * Always 200: { available: false } until the smart pass has run.
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    const file = path.join(STORAGE_ROOT, 'autocut', row.id, 'smart-transcript.json')
    if (!fs.existsSync(file)) {
      return Response.json({ available: false })
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TranscriptFile
    if (!parsed || !Array.isArray(parsed.utterances)) {
      return Response.json({ available: false })
    }
    return Response.json({ available: true, ...parsed })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] transcript error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
