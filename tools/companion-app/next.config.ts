import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Identity files are read from disk at request time; keep them out of the bundle
  // trace so editing one never requires a rebuild.
  serverExternalPackages: ["@anthropic-ai/sdk"],
};

export default nextConfig;
