import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/petty-cash/books
 * - Regular user: returns only their own book
 * - Manager/admin/accounts: returns all books (for audit)
 * Query params: ?all=true (for audit view)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "true";
  const canViewAll = ["admin", "manager", "accounts"].includes(dbUser.role);

  let query = supabase
    .from("petty_cash_books")
    .select("*, owner:users!petty_cash_books_user_id_fkey(id, full_name, email, role)")
    .order("created_at", { ascending: false });

  if (!all || !canViewAll) {
    query = query.eq("user_id", dbUser.id);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data || [] });
}

/**
 * POST /api/petty-cash/books — auto-create book for current user (if not exists)
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Check if book already exists
  const { data: existing } = await supabase
    .from("petty_cash_books")
    .select("id")
    .eq("user_id", dbUser.id)
    .single();

  if (existing) {
    return NextResponse.json({ data: existing });
  }

  const { data, error } = await supabase
    .from("petty_cash_books")
    .insert({ user_id: dbUser.id, current_balance: 0 })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
