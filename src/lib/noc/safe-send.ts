// A guard so that testing can never message a real customer. Outside real production, a message may only go to a
// reserved test address. In production it is a no-op. (The staging environment carries live email keys, so this is
// what makes clicking Send on a staging fixture safe: see CLAUDE.md, "Never let a real customer be touched by testing".)

const TEST_SUFFIXES = ["@example.com", "@example.org", "@example.net"];
const TEST_TLDS = [".test", ".invalid", ".example", ".localhost"];

export function isReservedTestAddress(email: string): boolean {
  const e = email.trim().toLowerCase();
  return TEST_SUFFIXES.some((s) => e.endsWith(s)) || TEST_TLDS.some((t) => e.endsWith(t));
}

import { isProductionDatabase } from "@/lib/environment";

/**
 * True only on the live system: a production build, deployed by Vercel as production, talking to the production
 * database. All three are required because each alone can lie: a local `.env.local` pulled from Vercel can carry
 * VERCEL_ENV="production" (it did, here), and a staging deployment can run a production build. `next dev` is never
 * production, whatever the env file says.
 */
export function isRealProduction(env: { nodeEnv?: string; vercelEnv?: string; productionDatabase?: boolean } = {
  nodeEnv: process.env.NODE_ENV, vercelEnv: process.env.VERCEL_ENV, productionDatabase: isProductionDatabase(),
}): boolean {
  return env.nodeEnv === "production" && env.vercelEnv === "production" && env.productionDatabase === true;
}

/** Returns an error message when the address must not be messaged from here, or null when it may be. */
export function unsafeRecipientReason(email: string, production: boolean = isRealProduction()): string | null {
  if (production) return null;
  return isReservedTestAddress(email)
    ? null
    : `Not sent: this is not the live system, and ${email} is not a test address. Customer messages from here may only go to example.com, example.org, example.net or .test addresses.`;
}
