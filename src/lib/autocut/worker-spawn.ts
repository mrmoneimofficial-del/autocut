/**
 * On-demand worker spawn — background daemons started from a shell in this
 * sandbox get reaped between tool calls, so the render worker is spawned as
 * a detached child of the (long-running) Next.js dev server whenever a job
 * is enqueued. A heartbeat file + health probe guard against double spawns.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WORKER_DIR = path.join(process.cwd(), 'mini-services', 'autocut-worker')
const HEARTBEAT = path.join(process.cwd(), 'storage', 'autocut', 'worker.json')
const WORKER_LOG = path.join(process.cwd(), 'storage', 'autocut', 'worker-next.log')
const HEALTH_PORT = 3040

let lastSpawnAttempt = 0

async function healthAlive(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 700)
    const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

function heartbeatAlive(): boolean {
  try {
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'))
    return typeof hb.ts === 'number' && Date.now() - hb.ts < 20_000
  } catch {
    return false
  }
}

/** Ensure exactly one render worker is running (spawns if needed). */
export async function ensureWorker(): Promise<void> {
  if (await healthAlive()) return
  if (heartbeatAlive()) return // fresh heartbeat but health down → starting up
  // throttle spawn attempts (crash loop protection)
  if (Date.now() - lastSpawnAttempt < 5_000) return
  lastSpawnAttempt = Date.now()
  try {
    const out = fs.openSync(WORKER_LOG, 'a')
    const child = spawn('bun', ['index.ts'], {
      cwd: WORKER_DIR,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, AUTOCUT_WORKER_PORT: String(HEALTH_PORT) },
    })
    child.unref()
    console.log(`[autocut] spawned render worker pid=${child.pid}`)
  } catch (e) {
    console.error('[autocut] worker spawn failed:', e)
  }
}
