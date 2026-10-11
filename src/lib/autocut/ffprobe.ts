/**
 * ffprobe wrappers — shared by the API server and the worker.
 * Uses only node builtins so the worker (separate bun project) can import it
 * via a relative path.
 */
import { spawn } from 'node:child_process'
import type { VideoMeta } from './types'

export const FFMPEG_BIN = process.env.FFMPEG_PATH ?? 'ffmpeg'
export const FFPROBE_BIN = process.env.FFPROBE_PATH ?? 'ffprobe'

export function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const cap = 400000 // keep memory bounded for large probe outputs
    p.stdout.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString('utf8')
    })
    p.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 40000) stderr += d.toString('utf8')
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        p.kill('SIGKILL')
      }, opts.timeoutMs)
    }
  })
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0
  const [a, b] = rate.split('/').map(Number)
  if (!b || Number.isNaN(a) || Number.isNaN(b)) return Number(rate) || 0
  return a / b
}

export interface ProbeResult {
  meta: VideoMeta
  raw: unknown
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { code, stdout, stderr } = await run(
    FFPROBE_BIN,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 120000 }
  )
  if (code !== 0) {
    throw Object.assign(new Error(stderr || `ffprobe exited ${code}`), { code: 'PROBE_FAILED' })
  }
  let data: any
  try {
    data = JSON.parse(stdout)
  } catch {
    throw Object.assign(new Error('ffprobe produced no JSON'), { code: 'PROBE_FAILED' })
  }
  const fmt = data.format ?? {}
  const streams: any[] = data.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const audioStreams = streams.filter((s) => s.codec_type === 'audio')
  const a = audioStreams[0]
  const durationSec = Number(fmt.duration ?? v?.duration ?? a?.duration ?? 0)
  const sizeBytes = Number(fmt.size ?? 0)
  const meta: VideoMeta = {
    durationMs: Math.round((Number.isFinite(durationSec) ? durationSec : 0) * 1000),
    width: v ? Number(v.width) || 0 : 0,
    height: v ? Number(v.height) || 0 : 0,
    fps: v ? Math.round(parseFps(v.r_frame_rate) * 1000) / 1000 : 0,
    videoCodec: v ? String(v.codec_name ?? 'unknown') : '',
    audioCodec: a ? String(a.codec_name ?? 'unknown') : '',
    audioChannels: a ? Number(a.channels) || 0 : 0,
    audioChannelLayout: a ? String(a.channel_layout ?? `${a.channels ?? '?'}ch`) : '',
    audioSampleRate: a ? Number(a.sample_rate) || 0 : 0,
    audioStreamCount: audioStreams.length,
    bitrate: Number(fmt.bit_rate) || 0,
    formatName: String(fmt.format_name ?? 'unknown'),
    sizeBytes,
    hasAudio: !!a,
    hasVideo: !!v,
    gopMs: null,
  }
  return { meta, raw: data }
}

/** Keyframe timestamps (seconds) of the first video stream — for Fast mode.
 *  Streams packet output line by line (long videos produce tens of MB). */
export async function listKeyframesStreaming(
  filePath: string,
  onProgress?: (fraction: number) => void
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE_BIN, [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      filePath,
    ])
    const times: number[] = []
    let buf = ''
    let first = -1
    let last = -1
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) continue
        const comma = line.indexOf(',')
        if (comma < 0) continue
        const flags = line.slice(comma + 1)
        if (flags.includes('K')) {
          const sec = Number(line.slice(0, comma))
          if (Number.isFinite(sec) && sec >= 0) {
            times.push(sec)
            if (first < 0) first = sec
            last = sec
          }
        }
      }
      if (onProgress && last > first) onProgress(Math.min(0.99, last / Math.max(1, first + 3600)))
    })
    p.stderr.on('data', () => {})
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffprobe keyframes exited ${code}`))
      else resolve(times)
    })
  })
}

export function medianGopMs(keyframeSecs: number[]): number | null {
  if (keyframeSecs.length < 3) return null
  const gaps: number[] = []
  for (let i = 1; i < keyframeSecs.length; i++) {
    const g = keyframeSecs[i] - keyframeSecs[i - 1]
    if (g > 0.01) gaps.push(g)
  }
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  return Math.round(gaps[Math.floor(gaps.length / 2)] * 1000)
}
