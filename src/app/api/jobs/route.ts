import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBins } from '@/lib/cloud'
import { bunnyConfigured } from '@/lib/bunny-storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')

/**
 * GET /api/jobs — capability probe. The frontend calls this on load to pick
 * its flow (uploads themselves ALWAYS go through the مستر منعم chunked
 * system at /api/uploads/chunked/*):
 *   mode 'server'     → storage writable → after the upload completes, the
 *                       classic local pipeline runs (staged job + timeline UI)
 *   mode 'cloud'      → storage read-only (Vercel…) but /tmp + ffmpeg OK →
 *                       streamed cloud cut from Bunny Storage
 *   mode 'cloud-lite' → no ffmpeg → upload + storage link only (no cut here)
 */
export async function GET() {
  let storageOK = false
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    const probe = path.join(ROOT, `.probe-${Date.now().toString(36)}-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    storageOK = true
  } catch { /* read-only serverless FS */ }

  let tmpOK = false
  try {
    const probe = path.join(os.tmpdir(), `.qattaas-probe-${Date.now().toString(36)}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    tmpOK = true
  } catch { /* exotic read-only /tmp */ }

  const cloud = { maxMB: Number(process.env.CLOUD_MAX_MB || 200), bunny: bunnyConfigured() }
  if (storageOK) return Response.json({ ok: true, mode: 'server', cloud })
  const bins = resolveBins()
  return Response.json({ ok: true, mode: bins.ok ? 'cloud' : 'cloud-lite', cloud, tmpOK })
}
