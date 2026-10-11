#!/bin/bash
# v8 finish: wait for parallel batches → requeue → worker concat/finalize → verify
cd /home/z/my-project/mini-services/autocut-worker
: > /tmp/v8_finish.log

# 1. wait for parallel renderer (max 30 min)
for i in $(seq 1 360); do
  if grep -q '"failed":' /tmp/v8_parallel_state.json 2>/dev/null && ! grep -q '"failed":null' /tmp/v8_parallel_state.json; then
    echo "$(date +%T) PARALLEL RENDER FAILED — ABORT" >> /tmp/v8_finish.log
    cat /tmp/v8_parallel.log >> /tmp/v8_finish.log; exit 1
  fi
  if grep -q 'finishedAt' /tmp/v8_parallel_state.json 2>/dev/null; then break; fi
  sleep 5
done
echo "$(date +%T) all batches done" >> /tmp/v8_finish.log

# 2. requeue + run worker to completion (concat+finalize, max 30 min)
bun v8-requeue2.ts >> /tmp/v8_finish.log 2>&1
timeout 1800 bun index.ts > /tmp/v8_worker.log 2>&1
echo "$(date +%T) worker exited rc=$?" >> /tmp/v8_finish.log

# 3. gap/size verification
bun v8-verify.ts > /tmp/v8_verify.log 2>&1
echo "$(date +%T) verify rc=$?" >> /tmp/v8_finish.log
tail -4 /tmp/v8_verify.log >> /tmp/v8_finish.log
