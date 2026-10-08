import { resolveBins, GOFILE_API, GOFILE_UPLOAD, gofileWebDownloadUrl } from '@/lib/cloud'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/cloud/diag — self-test of the server-side GoFile leg, so any
 * deployment (Vercel…) can report exactly what works from ITS network:
 *
 *   servers   → can we reach api.gofile.io at all?
 *   upload    → can we upload a tiny probe file to the upload fleet?
 *   meta      → does the owner-metadata lookup return a usable link?
 *   download  → can we actually download the bytes back?
 *
 * Results are cached in-process for 5 minutes. ?fresh=1 forces a re-run.
 */
let cache: { at: number; json: Record<string, unknown> } | null = null

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get('fresh') === '1'
  if (cache && !fresh && Date.now() - cache.at < 5 * 60_000) {
    return Response.json({ ...cache.json, cached: true })
  }

  const t = (ms: number) => `${ms}ms`
  const out: Record<string, unknown> = {
    ok: true,
    api: GOFILE_API,
    upload: GOFILE_UPLOAD,
    bins: resolveBins().ok,
    steps: {} as Record<string, unknown>,
  }
  const steps = out.steps as Record<string, any>

  // 1. api reachability
  let serverName = ''
  try {
    const t0 = Date.now()
    const r = await fetch(`${GOFILE_API}/servers`, { signal: AbortSignal.timeout(8_000) })
    const j = await r.json().catch(() => null)
    serverName = String(j?.data?.servers?.[0]?.name || '')
    steps.servers = { ok: j?.status === 'ok' && !!serverName, ms: t(Date.now() - t0), first: serverName }
  } catch (e: unknown) {
    steps.servers = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!steps.servers.ok) {
    out.verdict = 'gofile-unreachable-from-server'
    cache = { at: Date.now(), json: out }
    return Response.json(out)
  }

  // 2. tiny upload through the same fleet the browser uses
  let fileId = ''
  let fileName = ''
  let guestToken = ''
  try {
    const t0 = Date.now()
    const blob = new Blob([new Uint8Array(2048).fill(65)], { type: 'application/octet-stream' })
    const fd = new FormData()
    fd.append('file', blob, 'qattaas-diag.bin')
    const r = await fetch(GOFILE_UPLOAD, { method: 'POST', body: fd, signal: AbortSignal.timeout(20_000) })
    const j = await r.json().catch(() => null)
    fileId = String(j?.data?.id || '')
    fileName = String(j?.data?.name || 'qattaas-diag.bin')
    guestToken = String(j?.data?.guestToken || '')
    steps.upload = { ok: j?.status === 'ok' && !!fileId, ms: t(Date.now() - t0), guest: !!guestToken }
  } catch (e: unknown) {
    steps.upload = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!steps.upload.ok) {
    out.verdict = 'upload-fleet-blocked-from-server (browser uploads still fine — only server-side mirroring is affected)'
    cache = { at: Date.now(), json: out }
    return Response.json(out)
  }

  // 3. owner metadata → link
  let link = ''
  try {
    const t0 = Date.now()
    const r = await fetch(`${GOFILE_API}/contents/${encodeURIComponent(fileId)}`, {
      headers: guestToken ? { Authorization: `Bearer ${guestToken}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    const j = await r.json().catch(() => null)
    link = String(j?.data?.link || '')
    steps.meta = { ok: j?.status === 'ok', ms: t(Date.now() - t0), hasLink: !!link, premiumOnly: j?.status === 'error-notPremium' }
  } catch (e: unknown) {
    steps.meta = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // 4. download the bytes back — metadata link first, then the classic web URL
  const urls = [link, gofileWebDownloadUrl({ id: fileId, name: fileName, server: serverName })].filter(Boolean)
  let downloadOk = false
  for (const u of urls) {
    try {
      const t0 = Date.now()
      const r = await fetch(u, { signal: AbortSignal.timeout(15_000) })
      const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0))
      downloadOk = r.ok && buf.byteLength === 2048
      steps.download = { ok: downloadOk, ms: t(Date.now() - t0), via: u.includes('/download/web/') ? 'web-url' : 'meta-link', status: r.status, bytes: buf.byteLength }
      if (downloadOk) break
    } catch (e: unknown) {
      steps.download = { ok: false, error: e instanceof Error ? e.message : String(e), via: u.includes('/download/web/') ? 'web-url' : 'meta-link' }
    }
  }

  out.verdict = downloadOk
    ? 'gofile-fully-usable-from-server ✓'
    : 'server-can-upload-but-not-download (cut will fail here — uploads still work)'
  cache = { at: Date.now(), json: out }
  return Response.json(out)
}
