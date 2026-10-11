import type { JobError } from './types'

/** Typed error with a stable machine code + human explanation. */
export class AutoCutError extends Error {
  code: string
  details?: string
  httpStatus: number

  constructor(code: string, message: string, details?: string, httpStatus = 400) {
    super(message)
    this.code = code
    this.details = details
    this.httpStatus = httpStatus
  }

  toJSON(): JobError {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export const ERR = {
  jobNotFound: () =>
    new AutoCutError('JOB_NOT_FOUND', 'This job no longer exists. It may have been cleaned up.', undefined, 404),
  forbidden: () =>
    new AutoCutError(
      'FORBIDDEN',
      'You are not the owner of this job. Each upload belongs to the browser session that created it.',
      undefined,
      403
    ),
  missingToken: () =>
    new AutoCutError('MISSING_TOKEN', 'Missing owner token. Open the studio in the original browser session.', undefined, 401),
  badSignature: () =>
    new AutoCutError('BAD_SIGNATURE', 'This media link is invalid or has expired. Refresh the page to get a new one.', undefined, 403),
  noAudio: (details?: string) =>
    new AutoCutError(
      'NO_AUDIO_STREAM',
      'This file has no audible audio track, so silence detection is impossible. Check that the video contains sound.',
      details,
      422
    ),
  probeFailed: (details?: string) =>
    new AutoCutError(
      'PROBE_FAILED',
      'The video container could not be read. The file may be corrupted, truncated, or an unsupported format.',
      details,
      422
    ),
  envelopeFailed: (details?: string) =>
    new AutoCutError('AUDIO_DECODE_FAILED', 'The audio track could not be decoded while building the loudness map.', details, 422),
  storageFull: (neededMb: number, availMb: number) =>
    new AutoCutError(
      'STORAGE_FULL',
      `Not enough storage space to process this video. About ${Math.round(neededMb)} MB is required but only ${Math.round(
        availMb
      )} MB is free. Delete old jobs and try again.`,
      undefined,
      507
    ),
  sizeMismatch: (expected: number, got: number) =>
    new AutoCutError(
      'UPLOAD_SIZE_MISMATCH',
      `The upload does not match its declared size (${expected} bytes expected, ${got} received). Please retry the upload.`,
      undefined,
      422
    ),
  chunkOffset: (diskOffset: number) =>
    new AutoCutError(
      'CHUNK_OFFSET_MISMATCH',
      'The uploaded chunk does not line up with what is stored. The client will resync automatically.',
      `disk offset ${diskOffset}`,
      409
    ),
  invalidDecisions: (details: string) =>
    new AutoCutError('INVALID_DECISIONS', 'The cut list could not be validated: ' + details, details, 422),
  tooMuchRemoved: (pct: number) =>
    new AutoCutError(
      'TOO_MUCH_REMOVED',
      `Your current settings would remove ${pct.toFixed(1)}% of the video — essentially everything. Adjust the settings before rendering.`,
      undefined,
      422
    ),
  renderFailed: (details?: string) =>
    new AutoCutError('RENDER_FAILED', 'Rendering failed while encoding the video. You can retry — finished parts are kept.', details, 500),
  renderTimeout: () =>
    new AutoCutError(
      'RENDER_TIMEOUT',
      'Encoding one of the sections took too long and was stopped. Retry the render; it resumes from finished sections.',
      undefined,
      504
    ),
  notDetected: () =>
    new AutoCutError('NO_DETECTION', 'Analyze the video before rendering.', undefined, 409),
  wrongState: (status: string) =>
    new AutoCutError('WRONG_STATE', `This action is not available while the job is "${status}".`, undefined, 409),
  canceled: () => new AutoCutError('CANCELED', 'Processing was canceled.', undefined, 499),
  internal: (details?: string) =>
    new AutoCutError('INTERNAL', 'An unexpected server error occurred. It has been logged — you can safely retry.', details, 500),
}

export function errorFromJson(e: unknown): JobError {
  if (e instanceof AutoCutError) return e.toJSON()
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as JobError
  return { code: 'INTERNAL', message: 'An unexpected server error occurred.' }
}
