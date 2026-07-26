/**
 * POST /api/ruijie/vouchers/adhoc
 *
 * Issue an ad-hoc WiFi voucher for a Ruijie-managed location, from one of a
 * small explicitly-approved set of IT's existing generic packages (see
 * ADHOC_ALLOWED_PACKAGES in src/lib/ruijie.ts) — never the tenant-specific
 * packages, and never a custom duration (Ruijie can't do that).
 *
 * Admin and Manager roles: voucher is issued immediately.
 * All other roles: an approval_request is created (entity_type
 *   "ruijie_adhoc_voucher") and must be approved by an admin/manager first.
 *
 * Body:
 *   location_id   string  (required) — must have wifi_voucher_mode = 'ruijie_api'
 *   package_name  string  (required) — must be in ADHOC_ALLOWED_PACKAGES
 *   note          string  (required) — label for the voucher
 *   reason        string  (required for non-admin/manager) — justification
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  issueAdhocRuijieVoucher,
  siteConfigFromLocation,
  isRuijieLocation,
  ADHOC_ALLOWED_PACKAGES,
} from "@/lib/ruijie";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";

const bodySchema = z.object({
  location_id:  z.string().uuid(),
  package_name: z.string().min(1),
  note:         z.string().min(1).max(200),
  reason:       z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }
  const body = parsed.data;

  if (!ADHOC_ALLOWED_PACKAGES.includes(body.package_name as (typeof ADHOC_ALLOWED_PACKAGES)[number])) {
    return NextResponse.json(
      { error: `"${body.package_name}" is not an approved ad-hoc package. Allowed: ${ADHOC_ALLOWED_PACKAGES.join(", ")}` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: location } = await admin
    .from("locations")
    .select("id, name, wifi_voucher_mode, ruijie_group_id")
    .eq("id", body.location_id)
    .single();

  if (!location || !isRuijieLocation(location)) {
    return NextResponse.json({ error: "This location is not managed via the Ruijie API" }, { status: 400 });
  }
  const siteConfig = siteConfigFromLocation(location);
  if (!siteConfig) {
    return NextResponse.json({ error: "This location has no ruijie_group_id configured." }, { status: 400 });
  }

  const canIssueDirectly = ["admin", "manager"].includes(dbUser.role);

  // ── Direct issuance (admin / manager) ───────────────────────────────────────
  if (canIssueDirectly) {
    const comment = `adhoc_${body.note}`.slice(0, 200);
    const issued = await issueAdhocRuijieVoucher(siteConfig, body.package_name, comment);

    if ("error" in issued) {
      return NextResponse.json({ error: issued.error }, { status: 400 });
    }

    logAudit(admin, {
      entityType: "location",
      entityId:   body.location_id,
      action:     "create",
      performedBy: dbUser.id,
      changes: {
        type:               { old: null, new: "ruijie_adhoc_voucher" },
        ruijie_voucher_uuid: { old: null, new: issued.result.uuid },
        code:               { old: null, new: issued.result.code },
        package_used:       { old: null, new: issued.packageUsed },
        note:               { old: null, new: body.note },
      },
    });

    return NextResponse.json({
      issued: true,
      code: issued.result.code,
      ruijie_voucher_uuid: issued.result.uuid,
      package_used: issued.packageUsed,
      note: body.note,
    });
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
      entity_type:   "ruijie_adhoc_voucher",
      entity_id:     body.location_id,
      approval_type: "ruijie_adhoc_voucher",
      status:        "pending",
      requested_by:  dbUser.id,
      requested_at:  new Date().toISOString(),
      reason:        body.reason!.trim(),
      metadata: {
        location_id:   body.location_id,
        location_name: location.name,
        package_name:  body.package_name,
        note:          body.note,
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
      type:          { old: null, new: "ruijie_adhoc_voucher" },
      location_id:   { old: null, new: body.location_id },
      package_name:  { old: null, new: body.package_name },
    },
  });

  return NextResponse.json({
    issued: false,
    approval_request_id: approvalReq.id,
    message: "Your request has been submitted for manager/admin approval.",
  }, { status: 202 });
}
