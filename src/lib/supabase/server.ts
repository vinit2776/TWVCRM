import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  );
}

/**
 * Creates a true service-role Supabase client that bypasses RLS entirely.
 *
 * IMPORTANT: Do NOT use createServerClient (@supabase/ssr) for the admin
 * client. The SSR client injects the caller's session JWT (from cookies) as
 * the Authorization header, which overrides the service-role key and causes
 * RLS to apply as if the request came from the logged-in user. Non-admin
 * users (e.g. Sales Reps) would then be blocked from reading sensitive rows
 * such as razorpay_key_secret.
 *
 * The base @supabase/supabase-js createClient has no cookie/session
 * management, so the service-role key is used as-is and RLS is bypassed.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}
