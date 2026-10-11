import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

/** Available bytes on the volume of `dir` via `df` (Node has no statvfs). */
export function availableDiskBytes(dir: string): number | null {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  try {
    const r = spawnSync('df', ['-B1', '--output=avail', dir], { encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0 || !r.stdout) return null
    const lines = r.stdout.trim().split('\n')
    const avail = Number(lines[lines.length - 1])
    return Number.isFinite(avail) ? avail : null
  } catch {
    return null
  }
}
