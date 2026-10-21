/** The production Supabase project. Anything else is staging or local. */
export const PRODUCTION_SUPABASE_REF = "zlbvadtajetylacxevsm";

/**
 * Whether this deployment talks to the production database. Fails towards
 * "not production" for an unset URL, matching the STAGING banner, so callers
 * must only use it to relax something on staging, never to guard production.
 */
export function isProductionDatabase(): boolean {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(PRODUCTION_SUPABASE_REF);
}
