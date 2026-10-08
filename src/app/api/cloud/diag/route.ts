import { resolveBins, GOFILE_API, GOFILE_UPLOAD, resolveGofileDownload, downloadToFile } from '@/lib/cloud'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/cloud/diag — self-test of the server-side GoFile leg, so any
 * deployment (Vercel…) can report exactly what works from ITS network:
 *
 *   servers   → can we reach api.gofile.io at all?
 *   upload    → can we upload a tiny probe file to the upload fleet?
 *   download  → the REAL resolution chain (guest account + computed
 *               X-Website-Token → data.link → bytes) — same code the cut uses
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
  try {
    const t0 = Date.now()
    const r = await fetch(`${GOFILE_API}/servers`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8_000),
    })
    const j = await r.json().catch(() => null)
    steps.servers = { ok: j?.status === 'ok', ms: t(Date.now() - t0), first: j?.data?.servers?.[0]?.name || '' }
  } catch (e: unknown) {
    steps.servers = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!steps.servers.ok) {
    out.verdict = 'gofile-unreachable-from-server (datacenter IPs are often blocked by gofile — uploads from the browser still work)'
    cache = { at: Date.now(), json: out }
    return Response.json(out)
  }

  // 2. tiny upload through the same fleet the browser uses
  let fileId = ''
  let guestToken = ''
  try {
    const t0 = Date.now()
    const blob = new Blob([new Uint8Array(2048).fill(65)], { type: 'application/octet-stream' })
    const fd = new FormData()
    fd.append('file', blob, 'qattaas-diag.bin')
    const r = await fetch(GOFILE_UPLOAD, { method: 'POST', body: fd, signal: AbortSignal.timeout(20_000) })
    const j = await r.json().catch(() => null)
    fileId = String(j?.data?.id || '')
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

  // 3+4. the REAL download chain the cut uses
  const dest = path.join(os.tmpdir(), `qattaas-diag-${Date.now()}.bin`)
  try {
    const t0 = Date.now()
    const dl = await resolveGofileDownload({
      id: fileId, name: 'qattaas-diag.bin', size: 2048, guestToken: guestToken || undefined,
    })
    const ms = t(Date.now() - t0)
    const got = await downloadToFile(dl.url, dest, { maxBytes: 4096, headers: dl.headers, signal: AbortSignal.timeout(15_000) })
    steps.download = { ok: got === 2048, ms, via: dl.via, bytes: got }
  } catch (e: unknown) {
    steps.download = { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try { fs.rmSync(dest, { force: true }) } catch { /* ignore */ }
  }

  out.verdict = steps.download?.ok
    ? 'gofile-fully-usable-from-server ✓ (full cloud cut works here)'
    : 'server-cannot-download-from-gofile (cut will fail here — browser uploads still work; use Colab/Codespaces for the cut)'
  cache = { at: Date.now(), json: out }
  return Response.json(out)
}
