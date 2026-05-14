import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
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
