import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

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

  // Determine permission and next status
  if (entry.status === "pending_manager") {
    if (!["admin", "manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only managers/admins can approve at this stage" }, { status: 403 });
    }

    if (action === "reject") {
      await supabase.from("petty_cash_entries").update({
        status: "rejected",
        rejection_note: note || null,
      }).eq("id", id);

      await supabase.from("petty_cash_approvals").insert({
        approval_type: "entry",
        entry_id: id,
        approver_id: dbUser.id,
        approval_level: "manager",
        decision: "rejected",
        note: note || null,
      });

      logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: "pending_manager", new: "rejected" } } });

      return NextResponse.json({ success: true, status: "rejected" });
    }

    // Approve — check if needs admin approval (≥ ₹5000)
    const needsAdminApproval = Number(entry.amount) >= 5000;
    const nextStatus = needsAdminApproval ? "pending_admin" : "approved";

    await supabase.from("petty_cash_entries").update({ status: nextStatus }).eq("id", id);

    await supabase.from("petty_cash_approvals").insert({
      approval_type: "entry",
      entry_id: id,
      approver_id: dbUser.id,
      approval_level: "manager",
      decision: "approved",
      note: note || null,
    });

    // If fully approved, deduct from book balance
    if (nextStatus === "approved") {
      const book = entry.book as { id: string; current_balance: number };
      const newBalance = Number(book.current_balance) - Number(entry.amount);
      await supabase.from("petty_cash_books").update({ current_balance: newBalance }).eq("id", entry.book_id);
    }

    logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: "pending_manager", new: nextStatus } } });

    return NextResponse.json({ success: true, status: nextStatus });
  }

  if (entry.status === "pending_admin") {
    if (!["admin", "accounts"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin/accounts can approve at this stage" }, { status: 403 });
    }

    if (action === "reject") {
      await supabase.from("petty_cash_entries").update({
        status: "rejected",
        rejection_note: note || null,
      }).eq("id", id);

      await supabase.from("petty_cash_approvals").insert({
        approval_type: "entry",
        entry_id: id,
        approver_id: dbUser.id,
        approval_level: "admin",
        decision: "rejected",
        note: note || null,
      });

      logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: "pending_admin", new: "rejected" } } });

      return NextResponse.json({ success: true, status: "rejected" });
    }

    // Approve — final approval
    await supabase.from("petty_cash_entries").update({ status: "approved" }).eq("id", id);

    await supabase.from("petty_cash_approvals").insert({
      approval_type: "entry",
      entry_id: id,
      approver_id: dbUser.id,
      approval_level: "admin",
      decision: "approved",
      note: note || null,
    });

    // Deduct from book balance
    const book = entry.book as { id: string; current_balance: number };
    const newBalance = Number(book.current_balance) - Number(entry.amount);
    await supabase.from("petty_cash_books").update({ current_balance: newBalance }).eq("id", entry.book_id);

    logAudit(supabase, { entityType: "pc_entry", entityId: id, action: "update", performedBy: dbUser.id, changes: { status: { old: "pending_admin", new: "approved" } } });

    return NextResponse.json({ success: true, status: "approved" });
  }

  return NextResponse.json({ error: `Entry is in '${entry.status}' state and cannot be approved/rejected` }, { status: 400 });
}
