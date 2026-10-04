import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = path.join(process.cwd(), 'storage', 'jobs')
const EXT_OK = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.ts'])

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

    // sweep jobs older than 24h (renders never take that long)
    fs.mkdirSync(ROOT, { recursive: true })
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
