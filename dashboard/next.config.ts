import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is a self-contained app nested in the autoralph repo. Pin the
  // workspace root here so Turbopack doesn't walk up to the CLI's pnpm lockfile.
  turbopack: {
    root: path.join(__dirname),
  },
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
