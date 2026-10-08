import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // cloud mode runs inside a single request on serverless hosts — make sure
  // the pipeline runner and the bundled ffmpeg/ffprobe binaries travel with
  // the /api/cloud/cut function (and into the standalone build).
  outputFileTracingIncludes: {
    "/api/cloud/cut": [
      "./scripts/pipeline-runner.mjs",
      "./node_modules/ffmpeg-static/**",
      "./node_modules/ffprobe-static/**",
    ],
  },
};

export default nextConfig;
