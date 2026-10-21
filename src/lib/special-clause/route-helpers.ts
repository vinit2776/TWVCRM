import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "./service";

/** Resolves the signed-in CRM user, or the 401 response to return. */
export async function requireActor(supabase: SupabaseClient): Promise<{ actor: Actor } | { response: NextResponse }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  const row = data as { id: string; role: string; full_name: string | null } | null;
  if (!row) return { response: NextResponse.json({ error: "User not found" }, { status: 401 }) };
  return { actor: { id: row.id, role: row.role, name: row.full_name || "A teammate" } };
}
