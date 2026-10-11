import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // cloud mode runs inside a single request on serverless hosts — make sure
  // the pipeline runner and the bundled ffmpeg/ffprobe binaries travel with
  // EVERY api route (not just /api/cloud/cut): on Vercel, per-route config
  // differences (unique maxDuration OR unique tracing includes) split the
  // routes into SEPARATE serverless functions, and each function has its own
  // /tmp — the upload session dir would be invisible to the cut/stream
  // routes (found live on Vercel: cut always 401'd because it could never
  // see /tmp/uploads). One uniform config = ONE function = one shared /tmp.
  outputFileTracingIncludes: {
    "/api/**": [
      "./scripts/pipeline-runner.mjs",
      "./node_modules/ffmpeg-static/**",
      "./node_modules/ffprobe-static/**",
    ],
  },
};

export default nextConfig;
