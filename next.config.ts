import type { NextConfig } from "next";
import path from "path";
import { execSync } from "child_process";

// Source of truth for the app version — bump with `npm version patch|minor|major`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: pkgVersion } = require("./package.json") as { version: string };

function computeAppVersion(): string {
  return `v${pkgVersion}`;
}

/**
 * Short git SHA for the current HEAD. On Vercel, `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`
 * is also auto-injected — the sidebar prefers that one. This fallback gives the
 * local dev server a SHA too so the footer doesn't look half-empty.
 */
function computeShortSha(): string {
  try {
    const sha = execSync("git rev-parse --short=7 HEAD", { encoding: "utf-8" }).trim();
    if (/^[0-9a-f]{7}$/.test(sha)) return sha;
  } catch {
    /* fall through */
  }
  return "";
}

const nextConfig: NextConfig = {
  // DEBUG ONLY — enabling to decode a production hydration error's real stack
  // trace on the preview deploy. Revert before merging.
  productionBrowserSourceMaps: true,

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
    // Auto-bumped semver — increments on every commit to main.
    NEXT_PUBLIC_APP_VERSION: computeAppVersion(),
    // Local-build fallback for the short SHA. On Vercel,
    // NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA is auto-injected and is preferred.
    NEXT_PUBLIC_GIT_SHA: computeShortSha(),
  },
};

export default nextConfig;
