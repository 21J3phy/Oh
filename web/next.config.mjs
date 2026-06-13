import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives beside the CLI package (which has its own lockfile); pin the
  // trace root to web/ so Vercel builds and file tracing resolve here.
  outputFileTracingRoot: __dirname,
  // Serve the marketing landing (web/public/index.html, copied verbatim from
  // the old site/ project) at "/". The product app owns /login, /dashboard,
  // /team, /history, and /api/embed (the proxy the CLI calls) — so one Vercel
  // project, one domain, serves both. Point the project's Root Directory at
  // web/ in the Vercel dashboard.
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/index.html" }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
