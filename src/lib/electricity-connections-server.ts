import type { SupabaseClient } from "@supabase/supabase-js";
import {
  describeConflict,
  findConflicts,
  type CandidateConnection,
  type ConnectionLike,
} from "@/lib/electricity-connections";

/**
 * Identifier clashes for a candidate connection against every active connection of the
 * same vendor, at any location (a consumer number or remembered name must point at one
 * connection only). Returns ready-to-show sentences naming the other location.
 */
export async function connectionConflictMessages(
  admin: SupabaseClient,
  candidate: CandidateConnection,
  selfId?: string
): Promise<string[]> {
  const { data, error } = await admin
    .from("location_electricity_connections")
    .select("id, location_id, vendor_id, consumer_number, bill_aliases, is_active")
    .eq("vendor_id", candidate.vendor_id)
    .eq("is_active", true);
  if (error) throw new Error(error.message);

  const existing = (data ?? []) as ConnectionLike[];
  const conflicts = findConflicts(existing, candidate, selfId);
  if (conflicts.length === 0) return [];

  const ids = [...new Set(conflicts.map((c) => c.with.location_id))];
  const { data: locs } = await admin.from("locations").select("id, name").in("id", ids);
  const names = new Map((locs ?? []).map((l) => [l.id as string, l.name as string]));
  return conflicts.map((c) => describeConflict(c, (id) => names.get(id) ?? "another location"));
}
