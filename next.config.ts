import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },

  // Block all search engine indexing at the HTTP header level.
  // This is an internal tool — no public discovery should occur.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, nosnippet, noarchive, noimageindex" },
        ],
      },
    ];
  },

  env: {
    // Baked at compile time — always reflects the actual build date.
    // Vercel also injects NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA automatically.
    NEXT_PUBLIC_BUILD_DATE: new Date().toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }),
  },
};

export default nextConfig;
