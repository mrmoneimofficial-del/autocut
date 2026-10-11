import path from 'node:path'

/**
 * Storage layout — server + worker share these paths.
 *   <root>/<jobId>/original.<ext>   — pristine uploaded file (never modified)
 *   <root>/<jobId>/envelope.bin     — cached loudness envelope
 *   <root>/<jobId>/keyframes.txt    — keyframe timestamps (fast mode)
 *   <root>/<jobId>/segments/        — temporary render segments
 *   <root>/<jobId>/output.mp4       — final rendered video
 */
export const STORAGE_ROOT =
  process.env.AUTOCUT_STORAGE ?? path.join(process.cwd(), 'storage', 'autocut')

export function jobDir(jobId: string): string {
  // ids are server-generated uuids; still, never trust them in paths
  const safe = jobId.replace(/[^a-zA-Z0-9-]/g, '')
  if (!safe) throw new Error('invalid job id')
  return path.join(STORAGE_ROOT, safe)
}

export function originalPath(jobId: string, ext: string): string {
  const e = (ext || 'bin').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin'
  return path.join(jobDir(jobId), `original.${e}`)
}

export function envelopePath(jobId: string): string {
  return path.join(jobDir(jobId), 'envelope.bin')
}

export function keyframesPath(jobId: string): string {
  return path.join(jobDir(jobId), 'keyframes.txt')
}

export function segmentsDir(jobId: string): string {
  return path.join(jobDir(jobId), 'segments')
}

export function outputPath(jobId: string): string {
  return path.join(jobDir(jobId), 'output.mp4')
}

export function renderLogPath(jobId: string): string {
  return path.join(jobDir(jobId), 'render.log')
}

export function fileExt(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(name || '')
  return m ? m[1] : 'bin'
}
