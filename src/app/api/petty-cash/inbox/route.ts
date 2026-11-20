import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getPettyCashPolicy } from "@/lib/petty-cash-policy-server";
import {
  computeEntryFlags, isCleanForBulk, needsSecondApproval,
  type EntryFlag, type EntryStage,
} from "@/lib/petty-cash-approval";

const HISTORY_DAYS = 90;
const DUPLICATE_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export interface InboxItem {
  id: string;
  entry_number: string;
  date: string;
  amount: number;
  description: string;
  stage: EntryStage;
  category: { id: string; name: string } | null;
  person: { id: string; name: string };
  own: boolean;
  balance: number;
  needs_second_approval: boolean;
  attachment_count: number;
  flags: EntryFlag[];
  clean: boolean;
}

/**
 * GET /api/petty-cash/inbox
 * The expenses waiting on THIS person, oldest first, with what they need to decide:
 * balance, bills attached and warnings. Admin sees both stages, a manager stage 1,
 * accounts stage 2 — nobody sees an expense that is already decided.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const statuses: EntryStage[] | null =
    dbUser.role === "admin" ? ["pending_manager", "pending_admin"]
    : dbUser.role === "manager" ? ["pending_manager"]
    : dbUser.role === "accounts" ? ["pending_admin"]
    : null;
  if (!statuses) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const policy = await getPettyCashPolicy(createAdminClient());

  const { data: pending, error } = await supabase
    .from("petty_cash_entries")
    .select(`id, entry_number, date, amount, description, status, category_id, submitted_by,
      book:petty_cash_books!petty_cash_entries_book_id_fkey(current_balance),
      category:petty_cash_categories!petty_cash_entries_category_id_fkey(id, name),
      submitter:users!petty_cash_entries_submitted_by_fkey(id, full_name),
      attachments:petty_cash_attachments!petty_cash_attachments_entry_id_fkey(id)`)
    .in("status", statuses)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // One history query for everyone in the queue: usual spend and duplicate checks.
  const people = [...new Set((pending ?? []).map((e) => e.submitted_by))];
  const since = new Date(Date.now() - HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const { data: history } = people.length
    ? await supabase
        .from("petty_cash_entries")
        .select("id, submitted_by, category_id, amount, date, status")
        .in("submitted_by", people)
        .in("status", ["approved", "pending_manager", "pending_admin"])
        .gte("date", since)
    : { data: [] as { id: string; submitted_by: string; category_id: string | null; amount: number; date: string; status: string }[] };

  const items: InboxItem[] = (pending ?? []).map((e) => {
    const amount = Number(e.amount);
    const mine = (history ?? []).filter((h) => h.submitted_by === e.submitted_by && h.id !== e.id);
    const sameCat = mine.filter((h) => h.status === "approved" && h.category_id && h.category_id === e.category_id);
    const usualAvg = sameCat.length ? sameCat.reduce((s, h) => s + Number(h.amount), 0) / sameCat.length : null;
    const dup = mine.find((h) =>
      Number(h.amount) === amount &&
      Math.abs(new Date(h.date).getTime() - new Date(e.date).getTime()) <= DUPLICATE_WINDOW_DAYS * DAY_MS);
    const category = one(e.category);
    const attachmentCount = Array.isArray(e.attachments) ? e.attachments.length : 0;
    const stage = e.status as EntryStage;
    const own = e.submitted_by === dbUser.id;

    const flags = computeEntryFlags({
      amount, attachmentCount, nudgeAmount: policy.nudgeAmount, categoryName: category?.name ?? null,
      usualAvg, usualSamples: sameCat.length,
      duplicateOn: dup ? new Date(dup.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : null,
    });

    return {
      id: e.id, entry_number: e.entry_number, date: String(e.date).slice(0, 10), amount, description: e.description,
      stage, category, own,
      person: { id: e.submitted_by, name: one(e.submitter)?.full_name ?? "Unknown" },
      balance: Number(one(e.book)?.current_balance ?? 0),
      needs_second_approval: needsSecondApproval(amount, policy.secondApprovalAmount),
      attachment_count: attachmentCount,
      flags,
      clean: isCleanForBulk({ amount, attachmentCount, flags, own, stage }),
    };
  });

  return NextResponse.json({ data: items, viewer: { id: dbUser.id, role: dbUser.role }, policy });
}
