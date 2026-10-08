import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveBins } from '@/lib/cloud'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')
const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])

/**
 * GET /api/jobs — capability probe. The frontend calls this on load to pick
 * its flow:
 *   mode 'server'     → storage writable → classic chunked upload + local pipeline
 *   mode 'cloud'      → storage read-only (Vercel…) but ffmpeg available →
 *                       browser-direct GoFile upload + streamed cloud cut
 *   mode 'cloud-lite' → neither → upload + share link only (no cut here)
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
  const cloud = { maxMB: Number(process.env.CLOUD_MAX_MB || 200) }
  if (storageOK) return Response.json({ ok: true, mode: 'server' })
  const bins = resolveBins()
  return Response.json({ ok: true, mode: bins.ok ? 'cloud' : 'cloud-lite', cloud })
}

/** POST /api/jobs — { name, size } → { id } */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.slice(0, 200) : ''
    const size = Number(body?.size)
    if (!name || !Number.isFinite(size) || size < 1000 || size > 8 * 1024 ** 3) {
      return Response.json({ error: 'بيانات غير صحيحة' }, { status: 400 })
    }
    const ext = EXT_OK.has(path.extname(name).toLowerCase()) ? path.extname(name).toLowerCase() : '.mp4'

    // storage must be writable — serverless deploys (Vercel…) have a read-only FS.
    // probe by CREATING a unique file: writing an existing one can pass even when
    // new entries (job dirs) are blocked.
    try {
      fs.mkdirSync(ROOT, { recursive: true })
      const probe = path.join(ROOT, `.probe-${Date.now().toString(36)}-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
    } catch {
      return Response.json({
        error: 'السيرفر ده للعرض بس — التخزين مش متاح هنا. محتاج نسخة شغّالة عشان الرفع والقص',
      }, { status: 503 })
    }

    // sweep jobs older than 24h (renders never take that long)
    const now = Date.now()
    for (const id of fs.readdirSync(ROOT)) {
      const dir = path.join(ROOT, id)
      try {
        if (!/^[a-f0-9]{32}$/.test(id)) continue
        const st = fs.statSync(path.join(dir, 'job.json'))
        if (now - st.mtimeMs > 24 * 3600_000) fs.rmSync(dir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }

    // disk headroom: source + parts + output
    try {
      const fsStats = fs.statfsSync(ROOT)
      if (fsStats.bavail * fsStats.bsize < size * 1.6) {
        return Response.json({ error: 'مساحة التخزين مش كافية للملف ده' }, { status: 507 })
      }
    } catch { /* statfs unavailable → skip check */ }

    const id = crypto.randomBytes(16).toString('hex')
    const dir = path.join(ROOT, id)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'original' + ext), '')
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      id, name, size, ext, phase: 'uploading', uploaded: 0, createdAt: now,
    }))
    return Response.json({ id })
  } catch (e) {
    console.error('[jobs] create error:', e)
    return Response.json({ error: 'حصل خطأ — جرّب تاني' }, { status: 500 })
  }
}
