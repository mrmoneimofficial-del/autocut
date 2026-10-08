import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { resolveBins } from '@/lib/cloud'
import { bunnyConfigured, bunnyUrl } from '@/lib/bunny-storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/cloud/diag — one-shot health probe of the NEW upload/cut stack
 * (the مستر منعم chunked system + Bunny Storage). Answers, per deployment:
 *   • /tmp writable? (chunked upload sessions + cloud cut workspace)
 *   • Bunny Storage configured + reachable + writable from this host?
 *   • ffmpeg/ffprobe resolvable?
 */
export async function GET() {
  // /tmp writable?
  let tmpOK = false
  try {
    const probe = path.join(os.tmpdir(), `.qattaas-diag-${Date.now().toString(36)}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    tmpOK = true
  } catch { /* no /tmp */ }

  // Bunny Storage: configured → try an actual write+delete round-trip
  const configured = bunnyConfigured()
  let reachable = false
  let writable = false
  let detail = ''
  if (configured) {
    const probePath = `uploads/.diag-probe-${Date.now().toString(36)}`
    try {
      const r = await fetch(bunnyUrl(probePath), {
        method: 'PUT',
        headers: { AccessKey: process.env.BUNNY_STORAGE_PASSWORD!, 'Content-Type': 'application/octet-stream' },
        body: 'qattaas-diag',
        signal: AbortSignal.timeout(10_000),
      })
      if (r.ok) {
        writable = true
        reachable = true
        await fetch(bunnyUrl(probePath), {
          method: 'DELETE',
          headers: { AccessKey: process.env.BUNNY_STORAGE_PASSWORD! },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => { /* best-effort cleanup */ })
      } else {
        detail = `PUT ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}`
      }
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e)
    }
  }

  const bins = resolveBins()
  return Response.json({
    ok: true,
    tmp: tmpOK,
    bunny: { configured, reachable, writable, detail: detail || undefined },
    bins: { ok: bins.ok, ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe },
    maxMB: Number(process.env.CLOUD_MAX_MB || 200),
  })
}
