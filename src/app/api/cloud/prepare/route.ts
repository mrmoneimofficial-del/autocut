import { resolveBins, GOFILE_UPLOAD, GOFILE_API } from '@/lib/cloud'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let reachCache: { at: number; ok: boolean } | null = null

/** quick "can this server's network reach the GoFile API" check (cached 5 min) */
async function gofileReachable(): Promise<boolean> {
  if (reachCache && Date.now() - reachCache.at < 5 * 60_000) return reachCache.ok
  let ok = false
  try {
    const r = await fetch(`${GOFILE_API}/servers`, { signal: AbortSignal.timeout(6_000) })
    const j = await r.json().catch(() => null)
    ok = j?.status === 'ok'
  } catch { ok = false }
  reachCache = { at: Date.now(), ok }
  return ok
}

/**
 * GET /api/cloud/prepare — the browser asks where/how to upload directly.
 * The upload itself NEVER touches this server: the browser POSTs the file
 * straight to GoFile's upload fleet (CORS-enabled), so the host's body-size
 * limits are irrelevant.
 */
export async function GET() {
  const bins = resolveBins()
  const reachable = await gofileReachable()
  return Response.json({
    ok: true,
    upload: GOFILE_UPLOAD,
    maxMB: Number(process.env.CLOUD_MAX_MB || 200),
    cut: bins.ok,
    gofileReachable: reachable,
  })
}
