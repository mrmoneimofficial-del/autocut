/**
 * Loudness envelope binary codec.
 *
 * The envelope is extracted ONCE per job (16 kHz mono PCM → 20 ms frames) and
 * cached on disk. Every later re-detection — with any settings — runs against
 * this cache in milliseconds, without touching the video again. This is what
 * makes instant "re-analyze with new settings" possible on 4-hour videos.
 *
 * File layout (little endian):
 *   [0..3]   magic  "ACEN"
 *   [4..5]   u16 version (1)
 *   [6..7]   u16 frameMs
 *   [8..11]  u32 frameCount
 *   [12..]   i16 rms[frameCount]   (dB encoded: (db + 100) * 300)
 *   [..]     i16 peak[frameCount]  (same encoding)
 *
 * dB range -100..0 with ~0.003 dB precision. Total size for 4 hours: ~2.9 MB.
 */

export const ENVELOPE_MAGIC = 0x4e454341 // "ACEN" LE
export const ENVELOPE_VERSION = 1
export const ENVELOPE_HEADER_BYTES = 12
export const ENVELOPE_DB_OFFSET = 100
export const ENVELOPE_SCALE = 300

export interface EnvelopeData {
  frameMs: number
  frames: number
  rmsDb: Float32Array
  peakDb: Float32Array
}

export function encodeDb(db: number): number {
  const v = Math.round((Math.max(-100, Math.min(0, db)) + ENVELOPE_DB_OFFSET) * ENVELOPE_SCALE)
  return Math.max(0, Math.min(32767, v))
}

export function decodeDb(raw: number): number {
  return raw / ENVELOPE_SCALE - ENVELOPE_DB_OFFSET
}

export function envelopeByteSize(frameCount: number): number {
  return ENVELOPE_HEADER_BYTES + frameCount * 4
}

/** Build the envelope buffer from dB frame arrays. */
export function buildEnvelope(frameMs: number, rmsDb: Float32Array, peakDb: Float32Array): Uint8Array {
  const frames = Math.min(rmsDb.length, peakDb.length)
  const buf = new Uint8Array(envelopeByteSize(frames))
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, ENVELOPE_MAGIC, true)
  dv.setUint16(4, ENVELOPE_VERSION, true)
  dv.setUint16(6, frameMs, true)
  dv.setUint32(8, frames, true)
  for (let i = 0; i < frames; i++) {
    dv.setInt16(ENVELOPE_HEADER_BYTES + i * 2, encodeDb(rmsDb[i]), true)
    dv.setInt16(ENVELOPE_HEADER_BYTES + frames * 2 + i * 2, encodeDb(peakDb[i]), true)
  }
  return buf
}

/** Parse an envelope buffer (Node Buffer / ArrayBuffer). */
export function parseEnvelope(data: ArrayBuffer | Uint8Array): EnvelopeData {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (u8.byteLength < ENVELOPE_HEADER_BYTES) throw new Error('envelope too small')
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint32(0, true) !== ENVELOPE_MAGIC) throw new Error('bad envelope magic')
  const version = dv.getUint16(4, true)
  if (version !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${version}`)
  const frameMs = dv.getUint16(6, true)
  const frames = dv.getUint32(8, true)
  const expected = envelopeByteSize(frames)
  if (u8.byteLength < expected) throw new Error('envelope truncated')
  const rmsDb = new Float32Array(frames)
  const peakDb = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    rmsDb[i] = decodeDb(dv.getInt16(ENVELOPE_HEADER_BYTES + i * 2, true))
    peakDb[i] = decodeDb(dv.getInt16(ENVELOPE_HEADER_BYTES + frames * 2 + i * 2, true))
  }
  return { frameMs, frames, rmsDb, peakDb }
}

/** Aggregate a time window of the envelope into display buckets (min/max dB). */
export function bucketEnvelope(
  env: EnvelopeData,
  startMs: number,
  endMs: number,
  buckets: number
): { min: number[]; max: number[] } {
  const n = Math.max(1, Math.min(40000, Math.floor(buckets)))
  const min: number[] = new Array(n).fill(-100)
  const max: number[] = new Array(n).fill(-100)
  const totalMs = env.frames * env.frameMs
  const s = Math.max(0, startMs)
  const e = Math.min(totalMs, endMs)
  if (e <= s) return { min, max }
  const f0 = Math.floor(s / env.frameMs)
  const f1 = Math.min(env.frames - 1, Math.ceil(e / env.frameMs))
  const msPerBucket = (e - s) / n
  const framesPerBucket = Math.max(1, msPerBucket / env.frameMs)
  let b = 0
  for (let f = f0; f <= f1 && f < env.frames; f++) {
    b = Math.min(n - 1, Math.floor((f * env.frameMs - s) / msPerBucket))
    const r = env.rmsDb[f]
    if (r < min[b]) min[b] = r
    if (r > max[b]) max[b] = r
  }
  // frames-per-bucket < 1 leaves gaps; fill by sampling per bucket instead
  if (framesPerBucket < 1) {
    for (let i = 0; i < n; i++) {
      const t = s + (i + 0.5) * msPerBucket
      const f = Math.min(env.frames - 1, Math.floor(t / env.frameMs))
      if (f >= 0) {
        min[i] = env.rmsDb[f]
        max[i] = Math.max(env.peakDb[f], env.rmsDb[f])
      }
    }
  }
  return { min, max }
}
