/**
 * POST /api/autocut/deliver — fire-and-forget gofile uploader.
 * The Next.js dev server is a long-lived daemon, so a detached child spawned
 * here survives across client/tool-call boundaries (same pattern as the
 * worker's ffmpeg children). Body: { sourcePath, filename }.
 * Progress is observable via /tmp/deliver_state.txt + /tmp/deliver_result.json.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

export const dynamic = 'force-dynamic'

const GOFILE_TOKEN = '97UyuJ31nEGrScrExdCczPeatNxaRVN7'
const GOFILE_FOLDER = '9ba35e9d-4289-4a0d-9428-84479f1f5ee6'
const GOFILE_UPLOAD = 'https://store-na-phx-1.gofile.io/contents/uploadfile'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const sourcePath = String(body?.sourcePath ?? '')
  const filename = String(body?.filename ?? 'video.mp4')
  if (!sourcePath.startsWith('/home/z/my-project/storage/autocut/') || !fs.existsSync(sourcePath)) {
    return Response.json({ ok: false, error: 'invalid source path' }, { status: 400 })
  }
  if (!/^[\w.-]+$/.test(filename)) {
    return Response.json({ ok: false, error: 'invalid filename' }, { status: 400 })
  }

  const stateFile = '/tmp/deliver_state.txt'
  const resultFile = '/tmp/deliver_result.json'
  const logFile = '/tmp/deliver.log'
  fs.writeFileSync(stateFile, 'uploading')
  const size = fs.statSync(sourcePath).size

  const script = `#!/bin/bash
echo "[\$(date)] start ${filename} (${size} bytes)" >> ${logFile}
for ATTEMPT in 1 2 3; do
  rm -f ${resultFile}
  CODE=\$(curl -s -m 1800 -X POST "${GOFILE_UPLOAD}" \\
    -F "token=${GOFILE_TOKEN}" \\
    -F "folderId=${GOFILE_FOLDER}" \\
    -F "file=@${sourcePath};filename=${filename}" \\
    -o ${resultFile} -w "%{http_code}")
  echo "[\$(date)] attempt \$ATTEMPT http=\$CODE result=\$(head -c 200 ${resultFile} 2>/dev/null)" >> ${logFile}
  if grep -q '"status":"ok"' ${resultFile} 2>/dev/null; then
    echo "done" > ${stateFile}
    exit 0
  fi
  sleep 10
done
echo "failed" > ${stateFile}
`
  const scriptPath = `/tmp/deliver_$$.sh`
  fs.writeFileSync(scriptPath, script)
  fs.chmodSync(scriptPath, 0o755)

  const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()

  return Response.json({ ok: true, pid: child.pid, sizeBytes: size, filename })
}

export async function GET() {
  let state = 'idle'
  try {
    state = fs.readFileSync('/tmp/deliver_state.txt', 'utf8').trim()
  } catch {
    /* not started */
  }
  let result: unknown = null
  try {
    result = JSON.parse(fs.readFileSync('/tmp/deliver_result.json', 'utf8'))
  } catch {
    /* no result yet */
  }
  return Response.json({ state, result })
}
