import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ownerTokenFrom } from '@/lib/autocut/auth'
import { getOwnedJob } from '@/lib/autocut/job'
import { AutoCutError, ERR } from '@/lib/autocut/errors'
import { jobDir } from '@/lib/autocut/paths'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const WORKER_DIR = path.join(process.cwd(), 'mini-services', 'autocut-worker')
const BUN = process.env.BUN_BIN ?? '/usr/local/bin/bun'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * POST /api/autocut/jobs/:id/retranscribe — launch a long-running background
 * pipeline as a detached child of the dev server (survives the request AND
 * sandbox tool-call process reaping).
 *
 * Body: { mode: 'retranscribe' | 'turbo' | 'worker' }
 *  - retranscribe: dual-engine + LLM reconcile → new smart-transcript.json,
 *    flips the job to 'detected' on success (idempotent, resume-safe caches).
 *  - turbo: progressive whisper large-v3-turbo upgrade of the same transcript
 *    (single worker, RAM-gated; updates stageMessage so the UI auto-refreshes).
 *  - worker: restart the autocut job worker itself.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()

    let mode = 'retranscribe'
    let fast = false
    try {
      const body = (await req.json()) as { mode?: string; fast?: boolean }
      if (body?.mode && ['retranscribe', 'turbo', 'worker'].includes(body.mode)) {
        mode = body.mode
      }
      fast = !!body?.fast
    } catch {
      /* default mode */
    }

    if (mode === 'worker') {
      const logPath = '/home/z/my-project/.zscripts/mini-service-autocut-worker.log'
      const log = fs.openSync(logPath, 'a')
      const child = spawn(BUN, ['--hot', 'index.ts'], {
        cwd: WORKER_DIR,
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
      })
      child.unref()
      fs.closeSync(log)
      return Response.json({ started: true, mode, pid: child.pid })
    }

    const dir = jobDir(row.id)
    const pidFile = path.join(dir, mode === 'turbo' ? 'turbo.pid' : 'retranscribe.pid')
    if (fs.existsSync(pidFile)) {
      const old = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(old) && pidAlive(old)) {
        return Response.json({ started: false, alreadyRunning: true, pid: old })
      }
    }

    const script = mode === 'turbo' ? 'turbo-upgrade.ts' : 'retranscribe.ts'
    if (!fs.existsSync(path.join(WORKER_DIR, script))) {
      throw ERR.internal()
    }

    const logPath = path.join(dir, `${mode}.log`)
    const log = fs.openSync(logPath, 'a')
    const child = spawn(BUN, [script, row.id, ...(fast ? ['--fast'] : [])], {
      cwd: WORKER_DIR,
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    })
    child.unref()
    fs.closeSync(log)
    fs.writeFileSync(pidFile, String(child.pid))
    return Response.json({ started: true, mode, pid: child.pid })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    console.error('[autocut] retranscribe spawn error:', e)
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}

/** GET — lightweight status: is the pipeline running, last log lines. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const token = ownerTokenFrom(req)
    const row = await getOwnedJob(id, token)
    if (!row) throw ERR.jobNotFound()
    const dir = jobDir(row.id)
    const read = (name: string) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').slice(-15).join('\n')
      } catch {
        return ''
      }
    }
    const alive = (name: string) => {
      try {
        const pid = Number(fs.readFileSync(path.join(dir, name), 'utf8').trim())
        return Number.isFinite(pid) && pid > 0 && pidAlive(pid) ? pid : null
      } catch {
        return null
      }
    }
    return Response.json({
      retranscribe: { pid: alive('retranscribe.pid'), log: read('retranscribe.log') },
      turbo: { pid: alive('turbo.pid'), log: read('turbo.log') },
    })
  } catch (e) {
    if (e instanceof AutoCutError) return Response.json(e.toJSON(), { status: e.httpStatus })
    return Response.json(ERR.internal().toJSON(), { status: 500 })
  }
}
