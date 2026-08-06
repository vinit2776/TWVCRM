import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { flagTransferLine } from "@/lib/procurement/transfer-line-flags";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const CROSS_LOCATION_ROLES = ["admin", "manager", "office_admin"];

// Non-HQ roles may only view/act on transfers involving a location they're
// assigned to (matches the scoping already enforced on the list endpoint).
export async function canAccessTransfer(
  supabase: SupabaseClient,
  userId: string,
  role: string,
  fromLocationId: string,
  toLocationId: string
): Promise<boolean> {
  if (CROSS_LOCATION_ROLES.includes(role)) return true;
  const { data: assignedRows } = await supabase
    .from("user_locations")
    .select("location_id")
    .eq("user_id", userId);
  const assignedIds = new Set((assignedRows ?? []).map((r: { location_id: string }) => r.location_id));
  return assignedIds.has(fromLocationId) || assignedIds.has(toLocationId);
}

// Who to notify that a transfer needs dispatching: prefer people specifically
// assigned to the source location; if nobody's mapped there yet, fall back to
// every dispatch-capable role company-wide so the notification never goes nowhere.
async function resolveDispatchNotifyTargets(
  supabase: SupabaseClient,
  fromLocationId: string,
  excludeUserId: string
): Promise<string[]> {
  const { data: assignedRows, error: assignedError } = await supabase
    .from("user_locations")
    .select("user_id")
    .eq("location_id", fromLocationId);
  if (assignedError) console.error("[transfer notify] user_locations lookup failed:", assignedError.message);

  let ids: string[] = [];
  const assignedUserIds = (assignedRows ?? []).map((r: { user_id: string }) => r.user_id);
  if (assignedUserIds.length > 0) {
    const { data: roleFiltered, error: roleError } = await supabase
      .from("users")
      .select("id")
      .in("id", assignedUserIds)
      .in("role", CROSS_LOCATION_ROLES);
    if (roleError) console.error("[transfer notify] role filter lookup failed:", roleError.message);
    ids = (roleFiltered ?? []).map((r: { id: string }) => r.id);
  }

  if (ids.length === 0) {
    const { data: roleWide, error: roleWideError } = await supabase
      .from("users")
      .select("id")
      .in("role", CROSS_LOCATION_ROLES);
    if (roleWideError) console.error("[transfer notify] role-wide lookup failed:", roleWideError.message);
    ids = (roleWide ?? []).map((r: { id: string }) => r.id);
  }

  return Array.from(new Set(ids)).filter((uid) => uid !== excludeUserId);
}

// Who to notify that a transfer has been dispatched: the original requester
// plus anyone else assigned to the destination location.
async function resolveReceiptNotifyTargets(
  supabase: SupabaseClient,
  toLocationId: string,
  initiatedBy: string,
  excludeUserId: string
): Promise<string[]> {
  const { data: assigned } = await supabase
    .from("user_locations")
    .select("user_id")
    .eq("location_id", toLocationId);

  const ids = new Set((assigned ?? []).map((r: { user_id: string }) => r.user_id));
  ids.add(initiatedBy);
  ids.delete(excludeUserId);
  return Array.from(ids);
}

// Minimum consumption-log entries within 30 days before a location's own
// history is considered enough to skip the peer-locations benchmark.
const MIN_LOCAL_CONSUMPTION_LOGS = 3;

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Daily average headcount over the trailing 30-day window — averages
// same-day readings first so one noisy day can't skew the overall average.
function resolveHeadcount(readings: Array<{ recorded_at: string; total_count: number }>): number | null {
  const byDay = new Map<string, number[]>();
  for (const r of readings) {
    const day = r.recorded_at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(Number(r.total_count));
  }
  const dailyAverages = Array.from(byDay.values()).map((vals) => average(vals)!);
  return average(dailyAverages);
}

interface ApprovalIntelligenceItem {
  item_id: string;
  consumption_7d: number;
  consumption_30d: number;
  headcount: number | null;
  usage_per_head: number | null;
  // Same-methodology usage/head for the prior 30-day period (days 31-60 ago),
  // for the trend arrow next to the current figure. Only set when the current
  // usage_per_head is trustworthy on its own (not peer-benchmarked) — if local
  // history is too thin to trust for the current period, it's too thin to
  // trend against either.
  usage_per_head_prev_month: number | null;
  peer_usage_per_head: number | null;
  used_peer_benchmark: boolean;
}

// Approval-screen decision support: trailing consumption trend, headcount
// trend, and the derived usage/head ratio — flagged for the approver, never
// used to block. Falls back to a cross-location peer benchmark when a
// location's own history for an item is too thin to trust.
async function computeApprovalIntelligence(
  supabase: SupabaseClient,
  itemIds: string[],
  toLocationId: string
): Promise<{ items: ApprovalIntelligenceItem[]; openIssuesCount: number }> {
  if (itemIds.length === 0) return { items: [], openIssuesCount: 0 };

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // Widened to 60 days so the prior 30-day period (for the trend arrow) can
  // be sliced out of the same query instead of a second round-trip.
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const { data: localLogItems } = await supabase
    .from("consumption_log_items")
    .select("item_id, quantity_consumed, consumption_logs!inner(logged_at, location_id, status)")
    .in("item_id", itemIds)
    .eq("consumption_logs.location_id", toLocationId)
    .eq("consumption_logs.status", "active")
    .gte("consumption_logs.logged_at", sixtyDaysAgo);

  const { data: headcountReadings } = await supabase
    .from("space_headcounts")
    .select("recorded_at, total_count")
    .eq("location_id", toLocationId)
    .gte("recorded_at", sixtyDaysAgo);

  const avgHeadcount = resolveHeadcount((headcountReadings ?? []).filter((r) => r.recorded_at >= thirtyDaysAgo));
  const avgHeadcountPrev = resolveHeadcount(
    (headcountReadings ?? []).filter((r) => r.recorded_at >= sixtyDaysAgo && r.recorded_at < thirtyDaysAgo)
  );

  type LogItemRow = { item_id: string | null; quantity_consumed: number; consumption_logs: { logged_at: string } };
  const rows = (localLogItems ?? []) as unknown as LogItemRow[];

  const items: ApprovalIntelligenceItem[] = [];
  for (const itemId of itemIds) {
    const itemRows = rows.filter((r) => r.item_id === itemId);
    const current30dRows = itemRows.filter((r) => r.consumption_logs.logged_at >= thirtyDaysAgo);
    const prev30dRows = itemRows.filter(
      (r) => r.consumption_logs.logged_at >= sixtyDaysAgo && r.consumption_logs.logged_at < thirtyDaysAgo
    );
    const consumption7d = current30dRows
      .filter((r) => r.consumption_logs.logged_at >= sevenDaysAgo)
      .reduce((sum, r) => sum + Number(r.quantity_consumed), 0);
    const consumption30d = current30dRows.reduce((sum, r) => sum + Number(r.quantity_consumed), 0);
    const consumption30dPrev = prev30dRows.reduce((sum, r) => sum + Number(r.quantity_consumed), 0);

    const usagePerHead = avgHeadcount && avgHeadcount > 0 ? consumption30d / avgHeadcount : null;
    const usagePerHeadPrev = avgHeadcountPrev && avgHeadcountPrev > 0 ? consumption30dPrev / avgHeadcountPrev : null;

    let peerUsagePerHead: number | null = null;
    const usedPeerBenchmark = current30dRows.length < MIN_LOCAL_CONSUMPTION_LOGS;
    if (usedPeerBenchmark) {
      const { data: peerLogItems } = await supabase
        .from("consumption_log_items")
        .select("quantity_consumed, consumption_logs!inner(location_id, logged_at, status)")
        .eq("item_id", itemId)
        .neq("consumption_logs.location_id", toLocationId)
        .eq("consumption_logs.status", "active")
        .gte("consumption_logs.logged_at", thirtyDaysAgo);

      type PeerRow = { quantity_consumed: number; consumption_logs: { location_id: string } };
      const peerRows = (peerLogItems ?? []) as unknown as PeerRow[];
      const byLocation = new Map<string, number>();
      for (const r of peerRows) {
        byLocation.set(r.consumption_logs.location_id, (byLocation.get(r.consumption_logs.location_id) ?? 0) + Number(r.quantity_consumed));
      }
      const peerLocationIds = Array.from(byLocation.keys());
      if (peerLocationIds.length > 0) {
        const { data: peerHeadcounts } = await supabase
          .from("space_headcounts")
          .select("location_id, total_count")
          .in("location_id", peerLocationIds)
          .gte("recorded_at", thirtyDaysAgo);
        const headcountByLocation = new Map<string, number[]>();
        for (const h of peerHeadcounts ?? []) {
          if (!headcountByLocation.has(h.location_id)) headcountByLocation.set(h.location_id, []);
          headcountByLocation.get(h.location_id)!.push(Number(h.total_count));
        }
        const ratios: number[] = [];
        for (const locId of peerLocationIds) {
          const avgHc = average(headcountByLocation.get(locId) ?? []);
          const consumed = byLocation.get(locId) ?? 0;
          if (avgHc && avgHc > 0) ratios.push(consumed / avgHc);
        }
        peerUsagePerHead = average(ratios);
      }
    }

    items.push({
      item_id: itemId,
      consumption_7d: consumption7d,
      consumption_30d: consumption30d,
      headcount: avgHeadcount,
      usage_per_head: usagePerHead,
      usage_per_head_prev_month: usedPeerBenchmark ? null : usagePerHeadPrev,
      peer_usage_per_head: peerUsagePerHead,
      used_peer_benchmark: usedPeerBenchmark,
    });
  }

  // Open (unresolved) issues from past transfers into this location — a
  // trust signal about the location, surfaced alongside the item data.
  const { data: pastTransfers } = await supabase
    .from("stock_transfers")
    .select("id")
    .eq("to_location_id", toLocationId);
  const pastTransferIds = (pastTransfers ?? []).map((t: { id: string }) => t.id);

  let openIssuesCount = 0;
  if (pastTransferIds.length > 0) {
    const { count } = await supabase
      .from("stock_transfer_issues")
      .select("*", { count: "exact", head: true })
      .in("transfer_id", pastTransferIds)
      .neq("status", "resolved");
    openIssuesCount = count ?? 0;
  }

  return { items, openIssuesCount };
}

const patchTransferSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({
    action: z.literal("approve"),
    notes: z.string().optional(),
    // Explicit per-line decisions — required for any line the flagging
    // heuristic considers suspect (see flagTransferLine); lines omitted
    // here are auto-confirmed at their requested quantity.
    lines: z
      .array(
        z.object({
          transfer_item_id: z.string().uuid(),
          quantity_approved: z.number().min(0),
        })
      )
      .optional(),
  }),
  z.object({ action: z.literal("reject"), notes: z.string().min(1, "Rejection notes are required") }),
  z.object({
    action: z.literal("dispatch"),
    notes: z.string().optional(),
    items: z
      .array(
        z.object({
          transfer_item_id: z.string().uuid(),
          quantity_sent: z.number().min(0),
        })
      )
      .optional(),
  }),
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
      `*, stock_transfer_items(*, procurement_items(id, name)), stock_transfer_issues(*, resolver:users!stock_transfer_issues_resolved_by_fkey(id, full_name)), stock_transfer_attachments(*, uploader:users!stock_transfer_attachments_uploaded_by_fkey(id, full_name)), from_location:locations!stock_transfers_from_location_id_fkey(id, name, code), to_location:locations!stock_transfers_to_location_id_fkey(id, name, code), initiator:users!stock_transfers_initiated_by_fkey(id, full_name), approver:users!stock_transfers_approved_by_fkey(id, full_name), receiver:users!stock_transfers_received_by_fkey(id, full_name)`
    )
    .eq("id", id)
    .single();

  if (error || !transfer) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });

  if (!(await canAccessTransfer(supabase, dbUser.id, dbUser.role, transfer.from_location_id, transfer.to_location_id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  const approvalIntelligence = await computeApprovalIntelligence(supabase, itemIds, transfer.to_location_id);

  // Audit trail — full who/what/when for this transfer. Read with the admin
  // client so it's visible to anyone allowed to view the transfer (the
  // audit_trail table is otherwise admin-only via RLS).
  const adminSupabase = await createAdminClient();
  const { data: auditTrail } = await adminSupabase
    .from("audit_trail")
    .select(
      "id, action, changes, created_at, performer:users!audit_trail_performed_by_fkey(id, full_name, role)"
    )
    .eq("entity_type", "stock_transfer")
    .eq("entity_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    data: transfer,
    stock_levels: stockLevels,
    audit_trail: auditTrail ?? [],
    approval_intelligence: approvalIntelligence.items,
    open_issues_count: approvalIntelligence.openIssuesCount,
  });
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
    .select(
      "*, stock_transfer_items(*), from_location:locations!stock_transfers_from_location_id_fkey(id, name), to_location:locations!stock_transfers_to_location_id_fkey(id, name)"
    )
    .eq("id", id)
    .single();

  if (fetchError || !transfer) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });

  if (!(await canAccessTransfer(supabase, dbUser.id, dbUser.role, transfer.from_location_id, transfer.to_location_id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
    quantity_requested: number;
    quantity_approved: number | null;
    quantity_sent: number;
    quantity_received: number;
    approval_confirmed_at: string | null;
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

      const submittedLines = new Map((parsed.data.lines ?? []).map((l) => [l.transfer_item_id, l.quantity_approved]));

      // Re-derive the same "suspect" signal the approve screen showed —
      // enforced server-side so it can't be skipped by calling the API
      // directly. Non-suspect lines never need to appear in `lines`.
      const itemIds = transferItems.map((item) => item.item_id).filter(Boolean) as string[];
      const { items: intelItems } = await computeApprovalIntelligence(supabase, itemIds, transfer.to_location_id);
      const intelByItemId = new Map(intelItems.map((i) => [i.item_id, i]));

      const missingReview = transferItems.filter((item) => {
        if (submittedLines.has(item.id)) return false;
        const flag = flagTransferLine(item.quantity_requested, item.item_id ? intelByItemId.get(item.item_id) : undefined);
        return flag.suspect;
      });
      if (missingReview.length > 0) {
        return NextResponse.json({
          error: `${missingReview.length} item${missingReview.length === 1 ? "" : "s"} flagged for review and still need a decision: ${missingReview.map((i) => i.item_name).join(", ")}`,
        }, { status: 422 });
      }

      // Shortfall is final, not a block — no stock check here; that happens
      // at dispatch, where the issuer confirms what's actually physically sent.
      // Lines not explicitly submitted are bulk-confirmed at their requested
      // quantity (only reachable here for non-suspect lines, per the gate above).
      const resolvedApprovals = transferItems.map((item) => {
        const submittedQty = submittedLines.get(item.id);
        const approvedQty = submittedQty ?? item.quantity_requested;
        const method: "manual" | "bulk" = submittedLines.has(item.id) ? "manual" : "bulk";
        return { item, approvedQty, method };
      });

      for (const { item, approvedQty } of resolvedApprovals) {
        if (approvedQty > item.quantity_requested) {
          return NextResponse.json({
            error: `"${item.item_name}": approved quantity (${approvedQty}) cannot exceed requested (${item.quantity_requested})`,
          }, { status: 422 });
        }
      }

      for (const { item, approvedQty } of resolvedApprovals) {
        const { error: itemUpdateError } = await supabase
          .from("stock_transfer_items")
          .update({
            quantity_approved: approvedQty,
            approval_confirmed_at: new Date().toISOString(),
            approval_confirmed_by: dbUser.id,
          })
          .eq("id", item.id);
        if (itemUpdateError) return NextResponse.json({ error: itemUpdateError.message }, { status: 500 });
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
          approver_notes: parsed.data.notes?.trim() || null,
        })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      // One audit row per line, tagged by how it was approved — lets the
      // audit trail distinguish an approver's explicit decision from a
      // bulk auto-confirmation at the requested quantity.
      for (const { item, approvedQty, method } of resolvedApprovals) {
        await logAudit(supabase, {
          entityType: "stock_transfer",
          entityId: id,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            line_approved: { old: null, new: { item: item.item_name, qty: approvedQty, method } },
          },
        });
      }

      await logAudit(supabase, {
        entityType: "stock_transfer",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          status: { old: "pending_approval", new: "approved" },
          approver_notes: { old: null, new: parsed.data.notes ?? null },
          quantities_approved: {
            old: null,
            new: resolvedApprovals.map((r) => ({ item: r.item.item_name, qty: r.approvedQty })),
          },
        },
      });

      // Tell whoever handles dispatch at the source that this is ready.
      // Never blocks or fails the approval itself.
      try {
        const targets = await resolveDispatchNotifyTargets(supabase, transfer.from_location_id, dbUser.id);
        await createNotificationsForUsers(targets, {
          type: "transfer_approved",
          title: `Transfer ${transfer.transfer_number} approved — ready to dispatch`,
          body: `${transfer.from_location?.name ?? "Source"} → ${transfer.to_location?.name ?? "destination"}. Approved by ${dbUser.role}.`,
          url: `/procurement/transfers/${id}`,
          entityType: "stock_transfer",
          entityId: id,
        });
      } catch (err) {
        console.error("[transfer notify] approve targets failed:", err);
      }

      return NextResponse.json({ data: { id, status: "approved" } });
    }

    // ── REJECT ──────────────────────────────────────────────────────────────
    case "reject": {
      if (transfer.status !== "pending_approval") {
        return NextResponse.json({ error: "Only pending_approval transfers can be rejected" }, { status: 422 });
      }

      const { error: updateError } = await supabase
        .from("stock_transfers")
        .update({ status: "draft", approver_notes: parsed.data.notes })
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
      if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Insufficient permissions to dispatch" }, { status: 403 });
      }

      // Issuer can send less than approved per line (shortfall is final, not
      // a block) — whatever's actually on the shelf right now is what ships.
      const dispatchOverrides = new Map(
        (parsed.data.items ?? []).map((i) => [i.transfer_item_id, i.quantity_sent])
      );
      const resolvedDispatch = transferItems.map((item) => {
        const approvedQty = item.quantity_approved ?? item.quantity_requested;
        const sentQty = dispatchOverrides.has(item.id) ? dispatchOverrides.get(item.id)! : approvedQty;
        return { item, approvedQty, sentQty };
      });

      for (const { item, approvedQty, sentQty } of resolvedDispatch) {
        if (sentQty > approvedQty) {
          return NextResponse.json({
            error: `"${item.item_name}": quantity sent (${sentQty}) cannot exceed approved (${approvedQty})`,
          }, { status: 422 });
        }
      }

      // Deduct stock from source location and record the actual sent quantity
      for (const { item, sentQty } of resolvedDispatch) {
        const { error: itemUpdateError } = await supabase
          .from("stock_transfer_items")
          .update({ quantity_sent: sentQty })
          .eq("id", item.id);
        if (itemUpdateError) return NextResponse.json({ error: itemUpdateError.message }, { status: 500 });

        if (!item.item_id) continue;
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: transfer.from_location_id,
          p_item_id: item.item_id,
          p_quantity_delta: -sentQty,
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
        changes: {
          status: { old: "approved", new: "dispatched" },
          dispatch_notes: { old: null, new: parsed.data.notes ?? null },
          quantities_sent: {
            old: null,
            new: resolvedDispatch.map((r) => ({ item: r.item.item_name, qty: r.sentQty })),
          },
        },
      });

      // Tell the requester (and anyone else assigned to the destination) it's
      // on the way. Never blocks or fails the dispatch itself.
      try {
        const targets = await resolveReceiptNotifyTargets(supabase, transfer.to_location_id, transfer.initiated_by, dbUser.id);
        await createNotificationsForUsers(targets, {
          type: "transfer_dispatched",
          title: `Transfer ${transfer.transfer_number} dispatched — confirm receipt`,
          body: `${transfer.from_location?.name ?? "Source"} → ${transfer.to_location?.name ?? "destination"}. Dispatched by ${dbUser.role}.`,
          url: `/procurement/transfers/${id}`,
          entityType: "stock_transfer",
          entityId: id,
        });
      } catch (err) {
        console.error("[transfer notify] dispatch targets failed:", err);
      }

      return NextResponse.json({ data: { id, status: "dispatched" } });
    }

    // ── RECEIVE ──────────────────────────────────────────────────────────────
    case "receive": {
      if (transfer.status !== "dispatched") {
        return NextResponse.json({ error: "Only dispatched transfers can be received" }, { status: 422 });
      }

      // Check if destination has an active billing policy
      const { data: billingPolicy } = await supabase
        .from("transfer_billing_policies")
        .select("id, is_billable, contract_id, service_charge_pct")
        .eq("location_id", transfer.to_location_id)
        .eq("is_billable", true)
        .maybeSingle();

      if (billingPolicy) {
        // ── BILLABLE RECEIVE — delegate to atomic RPC ──────────────────────
        const rpcItems = parsed.data.items.map((ri) => ({
          transfer_item_id: ri.transfer_item_id,
          quantity_received: ri.quantity_received,
        }));

        const { data: rpcResult, error: rpcError } = await supabase.rpc(
          "receive_billable_transfer",
          {
            p_transfer_id: id,
            p_received_by: dbUser.id,
            p_items: rpcItems,
          }
        );

        if (rpcError) {
          return NextResponse.json({ error: rpcError.message }, { status: 500 });
        }

        await logAudit(supabase, {
          entityType: "stock_transfer",
          entityId: id,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            status: { old: "dispatched", new: rpcResult.status },
            billing_status: { old: "pending", new: "billed" },
            usage_charge_id: { old: null, new: rpcResult.usage_charge_id },
          },
        });

        return NextResponse.json({
          data: {
            id,
            status: rpcResult.status,
            billing_status: "billed",
            usage_charge_id: rpcResult.usage_charge_id,
            billing_summary: {
              base_value: rpcResult.base_value,
              service_charge: rpcResult.service_charge,
              subtotal: rpcResult.subtotal,
            },
          },
        });
      }

      // ── NON-BILLABLE RECEIVE — add stock to destination ────────────────────
      const receiveItems = parsed.data.items;
      let allMatch = true;

      for (const ri of receiveItems) {
        const transferItem = transferItems.find((ti) => ti.id === ri.transfer_item_id);
        if (!transferItem) {
          return NextResponse.json({ error: `Transfer item ${ri.transfer_item_id} not found` }, { status: 422 });
        }

        const { error: updateItemError } = await supabase
          .from("stock_transfer_items")
          .update({ quantity_received: ri.quantity_received })
          .eq("id", ri.transfer_item_id);

        if (updateItemError) return NextResponse.json({ error: updateItemError.message }, { status: 500 });

        if (transferItem.item_id && ri.quantity_received > 0) {
          const { error: stockError } = await supabase.rpc("upsert_location_stock", {
            p_location_id: transfer.to_location_id,
            p_item_id: transferItem.item_id,
            p_quantity_delta: ri.quantity_received,
          });
          if (stockError) {
            return NextResponse.json({ error: `Failed to add stock for "${transferItem.item_name}": ${stockError.message}` }, { status: 500 });
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
        status: "open",
      }));

      const { data: insertedIssues, error: issueError } = await supabase
        .from("stock_transfer_issues")
        .insert(issues)
        .select("id, transfer_item_id");
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

      return NextResponse.json({ data: { id, status: "issue_raised", issues: insertedIssues ?? [] } });
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
