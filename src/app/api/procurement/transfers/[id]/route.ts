import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { z } from "zod";

const patchTransferSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), notes: z.string().min(1, "Rejection notes are required") }),
  z.object({ action: z.literal("dispatch") }),
  z.object({
    action: z.literal("receive"),
    items: z
      .array(
        z.object({
          transfer_item_id: z.string().uuid(),
          quantity_received: z.number().min(0),
        })
      )
      .min(1),
  }),
  z.object({
    action: z.literal("report_issue"),
    items: z
      .array(
        z.object({
          transfer_item_id: z.string().uuid(),
          issue_type: z.enum(["shortage", "excess", "damage", "wrong_item", "quality", "other"]),
          reported_quantity: z.number().min(0),
          expected_quantity: z.number().min(0),
          description: z.string().optional(),
        })
      )
      .min(1),
  }),
  z.object({
    action: z.literal("resolve_issue"),
    issue_id: z.string().uuid(),
    resolution_notes: z.string().min(1),
    adjust_stock: z.boolean().optional(),
  }),
]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: transfer, error } = await supabase
    .from("stock_transfers")
    .select(
      `*, stock_transfer_items(*, procurement_items(id, name)), stock_transfer_issues(*, resolver:users!stock_transfer_issues_resolved_by_fkey(id, full_name)), from_location:locations!stock_transfers_from_location_id_fkey(id, name, code), to_location:locations!stock_transfers_to_location_id_fkey(id, name, code), initiator:users!stock_transfers_initiated_by_fkey(id, full_name), approver:users!stock_transfers_approved_by_fkey(id, full_name), receiver:users!stock_transfers_received_by_fkey(id, full_name)`
    )
    .eq("id", id)
    .single();

  if (error || !transfer) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });

  // Fetch stock levels for transfer items at both locations
  const itemIds = (transfer.stock_transfer_items as Array<{ item_id: string | null }>)
    .map((i) => i.item_id)
    .filter(Boolean) as string[];

  let stockLevels: unknown[] = [];
  if (itemIds.length > 0) {
    const { data: levels } = await supabase
      .from("location_stock")
      .select("*")
      .in("item_id", itemIds)
      .in("location_id", [transfer.from_location_id, transfer.to_location_id]);
    stockLevels = levels ?? [];
  }

  return NextResponse.json({ data: transfer, stock_levels: stockLevels });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: transfer, error: fetchError } = await supabase
    .from("stock_transfers")
    .select("*, stock_transfer_items(*)")
    .eq("id", id)
    .single();

  if (fetchError || !transfer) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });

  const body = await request.json();
  const parsed = patchTransferSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { action } = parsed.data;
  const transferItems = transfer.stock_transfer_items as Array<{
    id: string;
    item_id: string | null;
    item_name: string;
    quantity_sent: number;
    quantity_received: number;
  }>;

  switch (action) {
    // ── SUBMIT ──────────────────────────────────────────────────────────────
    case "submit": {
      if (transfer.status !== "draft") {
        return NextResponse.json({ error: "Only draft transfers can be submitted" }, { status: 422 });
      }

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({ status: "pending_approval" })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: { status: { old: "draft", new: "pending_approval" } },
      });

      return NextResponse.json({ data: { id, status: "pending_approval" } });
    }

    // ── APPROVE ─────────────────────────────────────────────────────────────
    case "approve": {
      if (transfer.status !== "pending_approval") {
        return NextResponse.json({ error: "Only pending_approval transfers can be approved" }, { status: 422 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only admins and managers can approve transfers" }, { status: 403 });
      }

      // Validate stock availability at from_location
      for (const item of transferItems) {
        if (!item.item_id) continue;
        const { data: stock } = await supabase
          .from("location_stock")
          .select("quantity_on_hand")
          .eq("location_id", transfer.from_location_id)
          .eq("item_id", item.item_id)
          .single();

        const onHand = stock?.quantity_on_hand ?? 0;
        if (item.quantity_sent > Number(onHand)) {
          return NextResponse.json({
            error: `"${item.item_name}": quantity to send (${item.quantity_sent}) exceeds available stock (${onHand}) at source location`,
          }, { status: 422 });
        }
      }

      const { count: transferApprovalCount } = await supabase
        .from("stock_transfers")
        .select("*", { count: "exact", head: true })
        .not("approval_code", "is", null);
      const transferApprovalCode = generateSignedApprovalCode("transfer", (transferApprovalCount ?? 0) + 1, id);

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({
          status: "approved",
          approved_by: dbUser.id,
          approved_at: new Date().toISOString(),
          approval_code: transferApprovalCode,
        })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: { status: { old: "pending_approval", new: "approved" } },
      });

      return NextResponse.json({ data: { id, status: "approved" } });
    }

    // ── REJECT ──────────────────────────────────────────────────────────────
    case "reject": {
      if (transfer.status !== "pending_approval") {
        return NextResponse.json({ error: "Only pending_approval transfers can be rejected" }, { status: 422 });
      }

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({ status: "draft", notes: parsed.data.notes })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          status: { old: "pending_approval", new: "draft" },
          rejection_notes: { old: null, new: parsed.data.notes },
        },
      });

      return NextResponse.json({ data: { id, status: "draft" } });
    }

    // ── DISPATCH ─────────────────────────────────────────────────────────────
    case "dispatch": {
      if (transfer.status !== "approved") {
        return NextResponse.json({ error: "Only approved transfers can be dispatched" }, { status: 422 });
      }
      if (!["admin", "manager", "floor_manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions to dispatch" }, { status: 403 });
      }

      // Deduct stock from source location
      for (const item of transferItems) {
        if (!item.item_id) continue;
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: transfer.from_location_id,
          p_item_id: item.item_id,
          p_quantity_delta: -item.quantity_sent,
        });
        if (rpcError) {
          return NextResponse.json({ error: `Failed to deduct stock for "${item.item_name}": ${rpcError.message}` }, { status: 500 });
        }
      }

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: { status: { old: "approved", new: "dispatched" } },
      });

      return NextResponse.json({ data: { id, status: "dispatched" } });
    }

    // ── RECEIVE ──────────────────────────────────────────────────────────────
    case "receive": {
      if (transfer.status !== "dispatched") {
        return NextResponse.json({ error: "Only dispatched transfers can be received" }, { status: 422 });
      }

      const receiveItems = parsed.data.items;
      let allMatch = true;

      for (const ri of receiveItems) {
        const transferItem = transferItems.find((ti) => ti.id === ri.transfer_item_id);
        if (!transferItem) {
          return NextResponse.json({ error: `Transfer item ${ri.transfer_item_id} not found` }, { status: 422 });
        }

        // Update quantity received on the transfer item
        const { error: updateItemError } = await supabase
          .from("stock_transfer_items")
          .update({ quantity_received: ri.quantity_received })
          .eq("id", ri.transfer_item_id);

        if (updateItemError) return NextResponse.json({ error: updateItemError.message }, { status: 500 });

        // Add stock to destination location
        if (transferItem.item_id && ri.quantity_received > 0) {
          const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
            p_location_id: transfer.to_location_id,
            p_item_id: transferItem.item_id,
            p_quantity_delta: ri.quantity_received,
          });
          if (rpcError) {
            return NextResponse.json({ error: `Failed to add stock for "${transferItem.item_name}": ${rpcError.message}` }, { status: 500 });
          }
        }

        if (ri.quantity_received !== transferItem.quantity_sent) {
          allMatch = false;
        }
      }

      const newStatus = allMatch ? "completed" : "received";

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({
          status: newStatus,
          received_by: dbUser.id,
          received_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: { status: { old: "dispatched", new: newStatus } },
      });

      return NextResponse.json({ data: { id, status: newStatus } });
    }

    // ── REPORT ISSUE ────────────────────────────────────────────────────────
    case "report_issue": {
      const issues = parsed.data.items.map((item) => ({
        transfer_id: id,
        transfer_item_id: item.transfer_item_id,
        issue_type: item.issue_type,
        reported_quantity: item.reported_quantity,
        expected_quantity: item.expected_quantity,
        description: item.description ?? null,
        reported_by: dbUser.id,
        status: "open",
      }));

      const { error: issueError } = await supabase.from("stock_transfer_issues").insert(issues);
      if (issueError) return NextResponse.json({ error: issueError.message }, { status: 500 });

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({ status: "issue_raised" })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          status: { old: transfer.status, new: "issue_raised" },
          issues_reported: { old: null, new: parsed.data.items.length },
        },
      });

      return NextResponse.json({ data: { id, status: "issue_raised" } });
    }

    // ── RESOLVE ISSUE ───────────────────────────────────────────────────────
    case "resolve_issue": {
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only admins and managers can resolve issues" }, { status: 403 });
      }

      const { data: issue, error: issueFetchError } = await supabase
        .from("stock_transfer_issues")
        .select("*")
        .eq("id", parsed.data.issue_id)
        .eq("transfer_id", id)
        .single();

      if (issueFetchError || !issue) {
        return NextResponse.json({ error: "Issue not found" }, { status: 404 });
      }

      if (issue.status === "resolved") {
        return NextResponse.json({ error: "Issue is already resolved" }, { status: 422 });
      }

      // Resolve the issue
      const { error: resolveError } = await supabase
        .from("stock_transfer_issues")
        .update({
          status: "resolved",
          resolution_notes: parsed.data.resolution_notes,
          resolved_by: dbUser.id,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", parsed.data.issue_id);

      if (resolveError) return NextResponse.json({ error: resolveError.message }, { status: 500 });

      // Optionally adjust stock for shortfall
      if (parsed.data.adjust_stock && issue.issue_type === "shortage") {
        const difference = Number(issue.expected_quantity) - Number(issue.reported_quantity);
        if (difference > 0) {
          // Find the item_id from the transfer item
          const transferItem = transferItems.find((ti) => ti.id === issue.transfer_item_id);
          if (transferItem?.item_id) {
            await supabase.rpc("upsert_location_stock", {
              p_location_id: transfer.to_location_id,
              p_item_id: transferItem.item_id,
              p_quantity_delta: difference,
            });
          }
        }
      }

      // Check if all issues are now resolved
      const { data: openIssues } = await supabase
        .from("stock_transfer_issues")
        .select("id")
        .eq("transfer_id", id)
        .neq("status", "resolved");

      if (!openIssues || openIssues.length === 0) {
        await supabase
          .from("stock_transfers")
          .update({ status: "completed" })
          .eq("id", id);
      }

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          issue_resolved: { old: null, new: parsed.data.issue_id },
          resolution_notes: { old: null, new: parsed.data.resolution_notes },
          adjust_stock: { old: null, new: parsed.data.adjust_stock ?? false },
        },
      });

      const allResolved = !openIssues || openIssues.length === 0;
      return NextResponse.json({
        data: {
          id,
          issue_id: parsed.data.issue_id,
          status: allResolved ? "completed" : "issue_raised",
        },
      });
    }
  }
}
