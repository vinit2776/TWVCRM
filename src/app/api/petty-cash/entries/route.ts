import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createEntrySchema = z.object({
  date: z.string().min(1, "Date is required"),
  amount: z.number().positive("Amount must be greater than 0"),
  category_id: z.string().uuid().optional(),
  description: z.string().min(1, "Description is required"),
  receipt_url: z.string().optional(),
  po_id: z.string().uuid().optional(),
});

function generateEntryNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `PCE-${yy}${mm}-${seq}`;
}

/**
 * GET /api/petty-cash/entries
 * Query params: ?status=pending_manager&book_id=xxx&category_id=xxx&page=1&limit=25
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
  const categoryId = searchParams.get("category_id");
  const myOnly = searchParams.get("my") === "true";
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  const canViewAll = ["admin", "manager", "accounts"].includes(dbUser.role);

  let query = supabase
    .from("petty_cash_entries")
    .select(
      `*, book:petty_cash_books!petty_cash_entries_book_id_fkey(id, user_id, current_balance, owner:users!petty_cash_books_user_id_fkey(id, full_name, email)), category:petty_cash_categories!petty_cash_entries_category_id_fkey(id, name), submitter:users!petty_cash_entries_submitted_by_fkey(id, full_name, email), purchase_order:purchase_orders!petty_cash_entries_po_id_fkey(id, po_number)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (bookId) query = query.eq("book_id", bookId);
  if (categoryId) query = query.eq("category_id", categoryId);
  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);
  if (myOnly || !canViewAll) query = query.eq("submitted_by", dbUser.id);

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
 * POST /api/petty-cash/entries — submit a spend entry
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const parsed = createEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // Ensure user has a book
  let { data: book } = await supabase
    .from("petty_cash_books").select("id, current_balance").eq("user_id", dbUser.id).single();
  if (!book) {
    const { data: newBook, error: bookErr } = await supabase
      .from("petty_cash_books")
      .insert({ user_id: dbUser.id, current_balance: 0 })
      .select("id, current_balance")
      .single();
    if (bookErr) return NextResponse.json({ error: bookErr.message }, { status: 500 });
    book = newBook;
  }

  // Check if PO-linked entry exceeds PO remaining balance
  if (parsed.data.po_id) {
    const { data: po } = await supabase
      .from("purchase_orders")
      .select("id, total_ordered_amount")
      .eq("id", parsed.data.po_id)
      .single();

    if (po) {
      // Sum existing approved PC entries linked to this PO
      const { data: existingEntries } = await supabase
        .from("petty_cash_entries")
        .select("amount")
        .eq("po_id", parsed.data.po_id)
        .in("status", ["pending_manager", "pending_admin", "approved"]);

      const totalSpent = (existingEntries || []).reduce((sum, e) => sum + Number(e.amount), 0);
      if (totalSpent + parsed.data.amount > Number(po.total_ordered_amount)) {
        return NextResponse.json({
          error: `This entry would exceed the PO's remaining balance. PO total: ₹${po.total_ordered_amount}, Already spent: ₹${totalSpent}`,
        }, { status: 400 });
      }
    }
  }

  // Generate entry number
  const { count } = await supabase
    .from("petty_cash_entries").select("id", { count: "exact", head: true });
  const entryNumber = generateEntryNumber(count || 0);

  const { data, error } = await supabase
    .from("petty_cash_entries")
    .insert({
      entry_number: entryNumber,
      book_id: book!.id,
      date: parsed.data.date,
      amount: parsed.data.amount,
      category_id: parsed.data.category_id || null,
      description: parsed.data.description,
      receipt_url: parsed.data.receipt_url || null,
      po_id: parsed.data.po_id || null,
      status: "pending_manager",
      submitted_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
