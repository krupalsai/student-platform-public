import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
  images: { remotePatterns: [{ protocol: "https", hostname: "*.supabase.co" }] },
  async headers() {
    return [
      {
        // The worker file itself must never be served stale: browsers only
        // pick up a new worker when they fetch a changed /sw.js, and a
        // cached copy delays every update (and every fix) by a day or more.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        // Same for the manifest, so install metadata never lags a deploy.
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};
export default nextConfig;
