import { run, FFMPEG_BIN, FFPROBE_BIN } from '@/lib/autocut/ffprobe'
import { STORAGE_ROOT } from '@/lib/autocut/paths'
import fs from 'node:fs'
import path from 'node:path'

export const dynamic = 'force-dynamic'

/** Liveness + capability probe used by the UI to warn early. */
export async function GET() {
  const ffmpeg = await run(FFMPEG_BIN, ['-version'], { timeoutMs: 10000 })
  const ffprobe = await run(FFPROBE_BIN, ['-version'], { timeoutMs: 10000 })
  let workerHeartbeatMs: number | null = null
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, 'worker.json'), 'utf8'))
    workerHeartbeatMs = Date.now() - hb.ts
  } catch {
    /* worker not started yet */
  }
  return Response.json({
    ok: ffmpeg.code === 0 && ffprobe.code === 0,
    ffmpeg: ffmpeg.code === 0,
    ffprobe: ffprobe.code === 0,
    workerAlive: workerHeartbeatMs != null && workerHeartbeatMs < 15000,
    workerHeartbeatMs,
  })
}
