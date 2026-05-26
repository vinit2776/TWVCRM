/**
 * POST /api/unifi/vouchers/adhoc
 *
 * Issue an ad-hoc WiFi voucher for a UniFi-managed location.
 *
 * Admin and Manager roles: voucher is issued immediately.
 * All other roles: an approval_request is created (entity_type "unifi_adhoc_voucher")
 *   and must be approved by an admin before the voucher is issued.
 *
 * Body:
 *   location_id      string  (required) — must have unifi_site_id
 *   duration_minutes number  (required) — 1 to 1,000,000
 *   note             string  (required) — label for the voucher
 *   quota            number  (optional, default 1) — max simultaneous devices
 *   reason           string  (required for non-admin/manager) — justification
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createUnifiVoucher } from "@/lib/unifi";
import { logAudit } from "@/lib/audit";

const bodySchema = z.object({
  location_id:      z.string().uuid(),
  duration_minutes: z.number().int().min(1).max(1_000_000),
  note:             z.string().min(1).max(200),
  quota:            z.number().int().min(1).max(100).optional().default(1),
  reason:           z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // Any staff can request — but only admin/manager bypass approval
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  // Verify location is UniFi-managed
  const admin = createAdminClient();
  const { data: location } = await admin
    .from("locations")
    .select("id, name, unifi_site_id")
    .eq("id", body.location_id)
    .single();

  if (!location?.unifi_site_id) {
    return NextResponse.json({ error: "This location is not managed via the UniFi API" }, { status: 400 });
  }

  const canIssueDirectly = ["admin", "manager"].includes(dbUser.role);

  // ── Direct issuance (admin / manager) ───────────────────────────────────────
  if (canIssueDirectly) {
    try {
      const { id: unifiId, code } = await createUnifiVoucher({
        durationMinutes: body.duration_minutes,
        note:            body.note,
        quota:           body.quota,
      });

      logAudit(admin, {
        entityType: "location",
        entityId:   body.location_id,
        action:     "create",
        performedBy: dbUser.id,
        changes: {
          type:             { old: null, new: "unifi_adhoc_voucher" },
          unifi_voucher_id: { old: null, new: unifiId },
          code:             { old: null, new: code },
          duration_minutes: { old: null, new: body.duration_minutes },
          quota:            { old: null, new: body.quota },
          note:             { old: null, new: body.note },
        },
      });

      return NextResponse.json({
        issued: true,
        code,
        unifi_voucher_id: unifiId,
        duration_minutes: body.duration_minutes,
        quota:            body.quota,
        note:             body.note,
      });
    } catch (err) {
      console.error("[api/unifi/vouchers/adhoc] direct issuance failed:", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "UniFi issuance failed" },
        { status: 502 }
      );
    }
  }

  // ── Approval-gated issuance (all other roles) ────────────────────────────────
  if (!body.reason?.trim()) {
    return NextResponse.json(
      { error: "A reason is required when requesting a voucher without manager/admin role." },
      { status: 400 }
    );
  }

  const { data: approvalReq, error: insertErr } = await admin
    .from("approval_requests")
    .insert({
      entity_type:   "unifi_adhoc_voucher",
      entity_id:     body.location_id,
      approval_type: "unifi_adhoc_voucher",
      status:        "pending",
      requested_by:  dbUser.id,
      requested_at:  new Date().toISOString(),
      reason:        body.reason!.trim(),
      metadata: {
        location_id:      body.location_id,
        location_name:    location.name,
        duration_minutes: body.duration_minutes,
        note:             body.note,
        quota:            body.quota,
        requested_by_name: dbUser.full_name,
      },
    })
    .select("id")
    .single();

  if (insertErr || !approvalReq) {
    return NextResponse.json({ error: insertErr?.message || "Failed to create approval request" }, { status: 500 });
  }

  logAudit(admin, {
    entityType: "approval_request",
    entityId:   approvalReq.id,
    action:     "create",
    performedBy: dbUser.id,
    changes: {
      type:             { old: null, new: "unifi_adhoc_voucher" },
      location_id:      { old: null, new: body.location_id },
      duration_minutes: { old: null, new: body.duration_minutes },
    },
  });

  return NextResponse.json({
    issued: false,
    approval_request_id: approvalReq.id,
    message: "Your request has been submitted for manager/admin approval.",
  }, { status: 202 });
}
