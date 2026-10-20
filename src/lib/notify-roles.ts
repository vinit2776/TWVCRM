// Push notifications to the people who own a lane, not to everyone.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "@/lib/push";

type Payload = Parameters<typeof sendPushToUsers>[1];

/** Pushes to every active user holding one of `roles`. If nobody does, falls back to
 *  `fallbackRoles` so a request is never announced to an empty room. Returns delivered count. */
export async function notifyRoles(
  supabase: SupabaseClient,
  roles: string[],
  payload: Payload,
  fallbackRoles: string[] = ["manager", "admin"]
): Promise<number> {
  const find = async (r: string[]) => {
    const { data } = await supabase.from("users").select("id").in("role", r).eq("is_active", true);
    return ((data ?? []) as { id: string }[]).map((u) => u.id);
  };
  let ids = await find(roles);
  if (ids.length === 0) ids = await find(fallbackRoles);
  return sendPushToUsers(ids, payload);
}
