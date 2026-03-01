import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/me
 * Returns the current user's role from the public.users table.
 * Using a server-side route means the Supabase call runs server-to-server,
 * so browser extensions that block cross-origin requests to supabase.co
 * cannot interfere with it.
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ role: "sales_rep" });
    }

    const { data } = await supabase
      .from("users")
      .select("role, full_name, email, phone")
      .eq("auth_id", user.id)
      .single();

    return NextResponse.json({
      role: data?.role ?? "sales_rep",
      full_name: data?.full_name ?? "",
      email: data?.email ?? "",
      phone: data?.phone ?? "",
    });
  } catch {
    return NextResponse.json({ role: "sales_rep" });
  }
}
