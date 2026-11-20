import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { canDecideEntry, nextStatusOnApprove, type EntryStage } from "@/lib/petty-cash-approval";
import { getPettyCashPolicy } from "@/lib/petty-cash-policy-server";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/petty-cash/entries/[id]
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("petty_cash_entries")
    .select(
      `*, book:petty_cash_books!petty_cash_entries_book_id_fkey(id, user_id, current_balance, owner:users!petty_cash_books_user_id_fkey(id, full_name, email)), category:petty_cash_categories!petty_cash_entries_category_id_fkey(id, name), submitter:users!petty_cash_entries_submitted_by_fkey(id, full_name, email), purchase_order:purchase_orders!petty_cash_entries_po_id_fkey(id, po_number)`
    )
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  // Also fetch approval history
  const { data: approvals } = await supabase
    .from("petty_cash_approvals")
    .select("*, approver:users!petty_cash_approvals_approver_id_fkey(id, full_name)")
    .eq("entry_id", id)
    .order("decided_at", { ascending: true });

  return NextResponse.json({ data, approvals: approvals || [] });
}

const approveSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});

const resubmitSchema = z.object({
  action: z.literal("resubmit"),
  date: z.string().min(1),
  amount: z.number().positive(),
  category_id: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
});

/**
 * PATCH /api/petty-cash/entries/[id] — approve or reject a spend entry
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();

  // Fetch current entry
  const { data: entry, error: fetchErr } = await supabase
    .from("petty_cash_entries")
    .select("*, book:petty_cash_books!petty_cash_entries_book_id_fkey(id, current_balance)")
    .eq("id", id)
    .single();

  if (fetchErr || !entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  // Handle resubmit — only the original submitter can resubmit a rejected entry
  if (body.action === "resubmit") {
    const resubmit = resubmitSchema.safeParse(body);
    if (!resubmit.success) return NextResponse.json({ error: resubmit.error.issues[0].message }, { status: 400 });

    if (entry.status !== "rejected") {
      return NextResponse.json({ error: "Only rejected entries can be resubmitted" }, { status: 400 });
    }
    if (entry.submitted_by !== dbUser.id) {
      return NextResponse.json({ error: "Only the original submitter can resubmit" }, { status: 403 });
    }

    const { date, amount, category_id, description } = resubmit.data;
    await supabase.from("petty_cash_entries").update({
      date,
      amount,
      category_id: category_id || null,
      description,
      status: "pending_manager",
      rejection_note: null,
    }).eq("id", id);

    logAudit(supabase, {
      entityType: "pc_entry",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "rejected", new: "pending_manager" }, amount: { old: entry.amount, new: amount }, description: { old: entry.description, new: description } },
    });

    return NextResponse.json({ success: true, status: "pending_manager" });
  }

  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const { action, note } = parsed.data;

  if (entry.status !== "pending_manager" && entry.status !== "pending_admin") {
    return NextResponse.json({ error: `Entry is in '${entry.status}' state and cannot be approved/rejected` }, { status: 400 });
  }
  // One place decides who may act: not your own expense, and only the right role for this stage.
  const decision = canDecideEntry(dbUser.role, dbUser.id, entry);
  if (!decision.ok) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const stage = entry.status as EntryStage;
  const policy = await getPettyCashPolicy(createAdminClient());
  const amount = Number(entry.amount);

  if (action === "reject") {
    await supabase.from("petty_cash_entries").update({ status: "rejected", rejection_note: note || null }).eq("id", id);
    await supabase.from("petty_cash_approvals").insert({
      approval_type: "entry",
      entry_id: id,
      approver_id: dbUser.id,
      approval_level: stage === "pending_manager" ? "manager" : "admin",
      decision: "rejected",
      note: note || null,
    });
    logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: stage, new: "rejected" } } });
    return NextResponse.json({ success: true, status: "rejected" });
  }

  const nextStatus = nextStatusOnApprove(dbUser.role, stage, amount, policy.secondApprovalAmount);
  // An admin approving a large amount at stage 1 covers both stages, so record it as an admin approval.
  const adminOneStep = stage === "pending_manager" && nextStatus === "approved" && amount >= policy.secondApprovalAmount;

  await supabase.from("petty_cash_entries").update({ status: nextStatus }).eq("id", id);
  await supabase.from("petty_cash_approvals").insert({
    approval_type: "entry",
    entry_id: id,
    approver_id: dbUser.id,
    approval_level: stage === "pending_manager" && !adminOneStep ? "manager" : "admin",
    decision: "approved",
    note: adminOneStep ? [note, "Admin approved in one step (covers both approval stages)"].filter(Boolean).join(" — ") : note || null,
  });

  if (nextStatus === "approved") {
    const book = entry.book as { id: string; current_balance: number };
    const newBalance = Number(book.current_balance) - amount;
    await supabase.from("petty_cash_books").update({ current_balance: newBalance }).eq("id", entry.book_id);
  }

  logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: stage, new: nextStatus } } });
  return NextResponse.json({ success: true, status: nextStatus });
}
