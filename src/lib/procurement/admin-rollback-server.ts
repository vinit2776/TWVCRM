import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canRollback } from "@/lib/procurement/admin-rollback";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Standard gate for admin-only rollback routes: signed in, and an admin.
 * Returns the caller or the response to send back.
 */
export async function requireRollbackAdmin(
  denyMessage: string
): Promise<{ supabase: Supabase; dbUser: { id: string; role: string } } | { error: NextResponse }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 403 }) };
  if (!canRollback(dbUser.role)) return { error: NextResponse.json({ error: denyMessage }, { status: 403 }) };
  return { supabase, dbUser };
}
