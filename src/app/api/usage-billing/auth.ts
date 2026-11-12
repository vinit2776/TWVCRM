import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Same roles that could Finalize & Send a usage statement before this flow. */
export const USAGE_BILLING_ROLES = ["admin", "manager", "accounts"];

export async function requireUsageBillingUser(): Promise<
  { userId: string; supabase: Awaited<ReturnType<typeof createClient>> } | { response: NextResponse }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !USAGE_BILLING_ROLES.includes(dbUser.role)) {
    return { response: NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 }) };
  }
  return { userId: dbUser.id as string, supabase };
}

export function errorStatus(code: string): number {
  return code === "stale" ? 409 : code === "not_found" ? 404 : code === "failed" ? 500 : 400;
}
