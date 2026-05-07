import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. Pages that call this at the top of a
 * component body (a common pattern across the codebase) execute
 * during Next.js prerender — and CI builds run with empty env vars,
 * which used to crash `createBrowserClient` with "Your project's URL
 * and API key are required."
 *
 * The fallback strings here make prerender succeed; real runtime in
 * production has the real env vars and behaves normally. The returned
 * client is never actually USED during prerender — all our queries
 * fire inside useEffect / event handlers, which only run client-side
 * after hydration where the env vars are set.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key"
  );
}
