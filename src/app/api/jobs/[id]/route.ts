import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')
const RUNNER = path.join(process.cwd(), 'scripts', 'pipeline-runner.mjs')
const ACTIVE = new Set(['uploading', 'analyzing', 'rendering'])

type Ctx = { params: Promise<{ id: string }> }

function readJSON<T = Record<string, unknown>>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}

function jobDirOf(id: string) { return path.join(ROOT, id) }

function statusOf(id: string) {
  const job = readJSON<Record<string, any>>(path.join(ROOT, id, 'job.json'))
  if (!job) return null
  const prog = readJSON(path.join(ROOT, id, 'progress.json'))
  const st: Record<string, any> = { ...job, progress: prog && ACTIVE.has(String(prog.phase)) ? prog : null }
  // live upload coverage — lets the client resume EXACTLY where it stopped
  if (st.phase === 'uploading') {
    const cov = readJSON<{ size: number; intervals: [number, number][] }>(path.join(ROOT, id, 'chunks.json'))
    if (cov && Array.isArray(cov.intervals)) {
      st.uploaded = cov.intervals.reduce((n: number, iv: any) => n + (Number(iv[1]) - Number(iv[0])), 0)
      st.uploadIntervals = cov.intervals
    }
  }
  return st
}

/** GET /api/jobs/:id — full status (polled by the UI). */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const st = statusOf(id)
  if (!st) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  return Response.json(st)
}

/** POST /api/jobs/:id — { action: 'analyze' } | { action:'render', gapMs, thresholdDb, crf } */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const dir = jobDirOf(id)
  const jobFile = path.join(dir, 'job.json')
  const job = readJSON<Record<string, any>>(jobFile)
  if (!job) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

  const body = await req.json().catch(() => null)
  const action = body?.action

  if (action === 'analyze') {
    // only from a fully-arrived file (coverage complete or phase already flipped)
    if (job.phase === 'uploading') {
      const cov = readJSON<{ size: number; intervals: [number, number][] }>(path.join(dir, 'chunks.json'))
      const covered = cov && Array.isArray(cov.intervals)
        ? cov.intervals.reduce((n: number, iv: any) => n + (Number(iv[1]) - Number(iv[0])), 0) : 0
      if (covered < job.size) return Response.json({ error: 'الرفع لسه مش خلص' }, { status: 409 })
      job.phase = 'uploaded'
    }
    if (job.phase !== 'uploaded' && job.phase !== 'error') {
      return Response.json({ error: 'الحالة الحالية مش صالحة للتحليل' }, { status: 409 })
    }
    job.phase = 'analyzing'
    job.error = undefined
    fs.writeFileSync(jobFile, JSON.stringify(job))
    spawnRunner(id, 'analyze')
    return Response.json({ ok: true })
  }

  if (action === 'render') {
    if (job.phase !== 'ready' && job.phase !== 'error') {
      return Response.json({ error: 'الفيديو مش جاهز للقص بعد' }, { status: 409 })
    }
    const settings = {
      gapMs: [100, 200, 300].includes(Number(body?.gapMs)) ? Number(body.gapMs) : 200,
      thresholdDb: [-40, -35, -30].includes(Number(body?.thresholdDb)) ? Number(body.thresholdDb) : -35,
      crf: [28, 32, 36].includes(Number(body?.crf)) ? Number(body.crf) : 32,
    }
    job.phase = 'rendering'
    job.error = undefined
    job.renderSettings = settings
    fs.writeFileSync(jobFile, JSON.stringify(job))
    spawnRunner(id, 'render', JSON.stringify(settings))
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'action غير معروف' }, { status: 400 })
}

/** Spawn the pipeline runner detached — it survives request end & HMR reloads. */
function spawnRunner(id: string, action: string, settings?: string) {
  const dir = jobDirOf(id)
  const logFd = fs.openSync(path.join(dir, 'spawn.log'), 'a')
  const child = spawn(process.execPath, [RUNNER, id, action, ...(settings ? [settings] : [])], {
    cwd: path.join(process.cwd(), 'scripts'),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  })
  child.unref()
  setTimeout(() => { try { fs.closeSync(logFd) } catch { /* already closed */ } }, 10_000)
}
