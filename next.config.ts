import type { NextConfig } from "next";
import path from "path";
import { execSync } from "child_process";

/**
 * Short git SHA for the current HEAD — what the sidebar badge shows, and the only
 * thing that actually identifies a deploy. On Vercel,
 * `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` is auto-injected and the sidebar prefers it;
 * this fallback gives the local dev server a SHA too.
 *
 * There used to be a semver here as well, read from package.json and bumped by a
 * workflow on every push to main. That workflow's PR could never satisfy the
 * Mainprotect ruleset — GitHub holds CI runs for Actions-bot PRs pending approval,
 * so the required check never reported — and the number silently froze at 1.0.98.471
 * on 2026-09-08 while the app kept shipping. A badge that reads as precise and is
 * five weeks stale is worse than no badge, and nothing else ever read the version.
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
    // Local-build fallback for the short SHA. On Vercel,
    // NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA is auto-injected and is preferred.
    NEXT_PUBLIC_GIT_SHA: computeShortSha(),
  },
};

export default nextConfig;
