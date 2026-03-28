import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createRequestSchema = z.object({
  amount_requested: z.number().positive("Amount must be greater than 0"),
  purpose: z.string().min(1, "Purpose is required"),
});

function generateRequestNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `PCR-${yy}${mm}-${seq}`;
}

/**
 * GET /api/petty-cash/requests
 * Query params: ?status=pending&book_id=xxx&page=1&limit=25
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const bookId = searchParams.get("book_id");
  const myOnly = searchParams.get("my") === "true";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  const canViewAll = ["admin", "manager", "accounts"].includes(dbUser.role);

  let query = supabase
    .from("petty_cash_requests")
    .select(
      `*, book:petty_cash_books!petty_cash_requests_book_id_fkey(id, user_id, current_balance, owner:users!petty_cash_books_user_id_fkey(id, full_name, email)), requester:users!petty_cash_requests_created_by_fkey(id, full_name, email), approver:users!petty_cash_requests_approved_by_fkey(id, full_name), issuer:users!petty_cash_requests_issued_by_fkey(id, full_name)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (bookId) query = query.eq("book_id", bookId);
  if (myOnly || !canViewAll) query = query.eq("created_by", dbUser.id);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data: data || [],
    pagination: {
      page, limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}

/**
 * POST /api/petty-cash/requests — submit a funding request
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // Ensure user has a book (create if needed)
  let { data: book } = await supabase
    .from("petty_cash_books").select("id").eq("user_id", dbUser.id).single();
  if (!book) {
    const { data: newBook, error: bookErr } = await supabase
      .from("petty_cash_books")
      .insert({ user_id: dbUser.id, current_balance: 0 })
      .select("id")
      .single();
    if (bookErr) return NextResponse.json({ error: bookErr.message }, { status: 500 });
    book = newBook;
  }

  // Generate request number
  const { count } = await supabase
    .from("petty_cash_requests").select("id", { count: "exact", head: true });
  const requestNumber = generateRequestNumber(count || 0);

  const { data, error } = await supabase
    .from("petty_cash_requests")
    .insert({
      request_number: requestNumber,
      book_id: book!.id,
      amount_requested: parsed.data.amount_requested,
      purpose: parsed.data.purpose,
      status: "pending",
      created_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
