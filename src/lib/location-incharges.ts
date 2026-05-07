/**
 * Floor in-charge recipient resolution
 *
 * Centralised so the cleaning email, check-in alert, headcount cron, and any
 * future location-scoped notification all share the same routing rules:
 *
 *   • Primary recipients  → the location's two designated in-charge users
 *                           (incharge_user_id_1 / incharge_user_id_2)
 *   • Supervisory CC      → users with the `manager` role
 *   • Excluded            → admin role (was historic noise; the user asked
 *                           for it to be dropped)
 *
 * Returns separate "to" and "cc" arrays so callers can pass them directly to
 * Resend — no surprise inclusions in either bucket. If a location has no
 * in-charges configured we fall back to the old broadcast (manager +
 * floor_manager) so cleaning alerts never silently disappear; this is the
 * safety valve until every location has its in-charges set.
 */
// We accept any Supabase client shape — server / admin / SSR. The query
// methods we use (.from / .select / .eq / .in / .not) are identical across
// all three, and pulling in the full SupabaseClient generics here just
// drags database type collisions across module boundaries.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

export interface RecipientUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
}

export interface LocationIncharges {
  /** Primary recipients — the designated in-charges of the location. */
  to: RecipientUser[];
  /** Supervisory CC — users with the manager role. */
  cc: RecipientUser[];
  /** True when no in-charge was configured and we fell back to broad routing. */
  fellBack: boolean;
}

export async function getLocationIncharges(
  supabase: AnyClient,
  locationId: string | null | undefined
): Promise<LocationIncharges> {
  // Always pull supervisory managers — they CC everything regardless of
  // whether the location has in-charges set.
  const { data: managers } = await supabase
    .from("users")
    .select("id, email, full_name, role")
    .eq("role", "manager")
    .eq("is_active", true)
    .not("email", "is", null);

  const cc: RecipientUser[] = (managers || []) as RecipientUser[];

  if (!locationId) {
    // No location context — fall back so cleaning alerts still go somewhere.
    const { data: fallback } = await supabase
      .from("users")
      .select("id, email, full_name, role")
      .in("role", ["floor_manager", "manager"])
      .eq("is_active", true)
      .not("email", "is", null);
    return { to: (fallback || []) as RecipientUser[], cc: [], fellBack: true };
  }

  const { data: location } = await supabase
    .from("locations")
    .select("incharge_user_id_1, incharge_user_id_2")
    .eq("id", locationId)
    .single();

  const inchargeIds = [
    location?.incharge_user_id_1,
    location?.incharge_user_id_2,
  ].filter(Boolean) as string[];

  if (inchargeIds.length === 0) {
    // Location exists but no one is designated yet — fall back to all
    // floor_managers so the alert isn't dropped on the floor. Logged so
    // an admin can see this is a config gap, not a regression.
    console.warn(`[incharges] location ${locationId} has no in-charges set — falling back to all floor_managers`);
    const { data: fallback } = await supabase
      .from("users")
      .select("id, email, full_name, role")
      .eq("role", "floor_manager")
      .eq("is_active", true)
      .not("email", "is", null);
    return { to: (fallback || []) as RecipientUser[], cc, fellBack: true };
  }

  const { data: incharges } = await supabase
    .from("users")
    .select("id, email, full_name, role")
    .in("id", inchargeIds)
    .eq("is_active", true)
    .not("email", "is", null);

  return {
    to: (incharges || []) as RecipientUser[],
    // Strip any manager who is also one of the in-charges — they'd get the
    // mail twice (To + CC) which looks sloppy.
    cc: cc.filter((m) => !inchargeIds.includes(m.id)),
    fellBack: false,
  };
}

/**
 * Returns the user IDs that should receive a push notification for an event
 * at this location: the in-charges (primary), plus managers (supervisory).
 * Used by lib/push helpers to look up push_subscriptions.user_id IN (...).
 */
export async function getLocationInchargeUserIds(
  supabase: AnyClient,
  locationId: string | null | undefined
): Promise<{ primary: string[]; supervisory: string[] }> {
  const { data: managers } = await supabase
    .from("users")
    .select("id")
    .eq("role", "manager")
    .eq("is_active", true);
  const supervisory: string[] = (managers || []).map((m: { id: string }) => m.id);

  if (!locationId) {
    return { primary: [], supervisory };
  }

  const { data: location } = await supabase
    .from("locations")
    .select("incharge_user_id_1, incharge_user_id_2")
    .eq("id", locationId)
    .single();

  const primary = [
    location?.incharge_user_id_1,
    location?.incharge_user_id_2,
  ].filter(Boolean) as string[];

  return {
    primary,
    // De-dupe against primary so a manager who's also an in-charge isn't
    // counted twice.
    supervisory: supervisory.filter((id: string) => !primary.includes(id)),
  };
}
