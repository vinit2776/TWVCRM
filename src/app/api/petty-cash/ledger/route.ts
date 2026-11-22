import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reconcile } from "@/lib/petty-cash-ledger";

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const PAGE = 100;

/**
 * GET /api/petty-cash/ledger?book_id=… (defaults to your own book)
 * The statement: every rupee in or out, newest first, with the running balance after each row
 * and a check that the rows add up to the book's balance. Management sees any book; others only their own.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const canViewAll = ["admin", "manager", "accounts"].includes(dbUser.role);
  const requested = new URL(request.url).searchParams.get("book_id");

  let bookQ = supabase.from("petty_cash_books")
    .select("id, user_id, current_balance, owner:users!petty_cash_books_user_id_fkey(full_name)");
  bookQ = requested && canViewAll ? bookQ.eq("id", requested) : bookQ.eq("user_id", dbUser.id);
  const { data: book } = await bookQ.maybeSingle();
  if (!book) return NextResponse.json({ data: [], book: null, reconciliation: null });

  const [{ data: rows, error }, { data: all }] = await Promise.all([
    supabase.from("petty_cash_ledger")
      .select(`id, kind, amount, balance_after, note, created_at,
        entry:petty_cash_entries!petty_cash_ledger_entry_id_fkey(id, entry_number, attachments:petty_cash_attachments!petty_cash_attachments_entry_id_fkey(id)),
        request:petty_cash_requests!petty_cash_ledger_request_id_fkey(id, request_number, issuance_method, issuance_reference),
        creator:users!petty_cash_ledger_created_by_fkey(full_name)`)
      .eq("book_id", book.id).order("created_at", { ascending: false }).limit(PAGE),
    supabase.from("petty_cash_ledger").select("amount").eq("book_id", book.id),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    book: { id: book.id, owner: one(book.owner)?.full_name ?? null, balance: Number(book.current_balance) },
    data: (rows ?? []).map((r) => {
      const entry = one(r.entry);
      const req = one(r.request);
      return {
        id: r.id, kind: r.kind, amount: Number(r.amount), balance_after: Number(r.balance_after),
        note: r.note, created_at: r.created_at, by: one(r.creator)?.full_name ?? null,
        entry_number: entry?.entry_number ?? null,
        bill_count: entry && Array.isArray(entry.attachments) ? entry.attachments.length : null,
        request_number: req?.request_number ?? null,
        issuance_method: req?.issuance_method ?? null,
        issuance_reference: req?.issuance_reference ?? null,
      };
    }),
    truncated: (all?.length ?? 0) > PAGE,
    reconciliation: reconcile((all ?? []).map((r) => Number(r.amount)), Number(book.current_balance)),
  });
}
