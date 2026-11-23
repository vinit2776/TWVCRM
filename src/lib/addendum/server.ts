import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Actor {
  id: string;
  role: string;
  name: string;
}

/** Signed-in staff member, or a ready-made error response. */
export async function getActor(supabase: SupabaseClient): Promise<{ actor: Actor } | { error: NextResponse }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 403 }) };
  return { actor: { id: dbUser.id, role: dbUser.role, name: dbUser.full_name ?? "" } };
}

export const reference = (contractNumber: string, n: number) => `${contractNumber}/ADD-${n}`;
