import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { releaseDecision } from "@/lib/vo-address-watch";
import {
  ADDRESS_EVIDENCE_ROLES,
  addressCheckSchema,
  addressReleaseSchema,
  dayOffsetFrom,
  findingOf,
  isMissingSchema,
  isProofRecorded,
  verdictForFinding,
} from "@/lib/vo-address-evidence";

/**
 * GET   /api/cases/[id]/address-checks — the evidence trail, oldest first.
 * POST  /api/cases/[id]/address-checks — record a public-record check by hand.
 * PATCH /api/cases/[id]/address-checks — { action: "release", reason }: a person
 *       confirms the address is released (two clear checks or recorded proof).
 *
 * Recording evidence contacts no one and bills nothing. The tables arrive with
 * migration 00680; until then every call answers "not available yet".
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = { error: "Address watch is not available yet (database update pending)." };

async function authorise() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { dbUser: dbUser as { id: string; role: string; full_name: string | null } };
}

const CHECK_COLUMNS = "id, checked_at, day_offset, source, result, verdict, evidence_ref, checked_by, raw";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;

  const admin = await createAdminClient();
  const { data: checks, error } = await admin
    .from("vo_address_checks")
    .select(CHECK_COLUMNS)
    .eq("case_id", id)
    .order("checked_at", { ascending: true });
  if (error) {
    if (isMissingSchema(error)) return NextResponse.json({ data: { available: false, checks: [] } });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: c } = await admin.from("cases").select("status, lapsed_at, address_status").eq("id", id).maybeSingle();
  const list = (checks ?? []) as { checked_at: string; verdict: "in_use" | "likely" | "inconclusive" | "clear"; raw: unknown }[];
  const proof = isProofRecorded(list);
  return NextResponse.json({
    data: {
      available: true,
      can_record: ADDRESS_EVIDENCE_ROLES.includes(auth.dbUser.role),
      status: (c as { status?: string } | null)?.status ?? null,
      lapsed_at: (c as { lapsed_at?: string | null } | null)?.lapsed_at ?? null,
      address_status: (c as { address_status?: string | null } | null)?.address_status ?? null,
      release_ready: proof || releaseDecision(list.map((x) => ({ checkedAt: x.checked_at, verdict: x.verdict }))) === "ready",
      checks: (checks ?? []).map((x) => ({ ...(x as object), finding: findingOf(x as { raw?: unknown }) })),
    },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;
  if (!ADDRESS_EVIDENCE_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager or accounts can record an address check" }, { status: 403 });
  }

  const parsed = addressCheckSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;

  const admin = await createAdminClient();
  const { data: c } = await admin.from("cases").select("id, status, lapsed_at").eq("id", id).maybeSingle();
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const row = c as { status: string; lapsed_at: string | null };
  if (row.status !== "lapsed" || !row.lapsed_at) {
    return NextResponse.json({ error: "Address checks apply to a lapsed case." }, { status: 409 });
  }

  const verdict = verdictForFinding(body.finding, body.source);
  const { data: inserted, error } = await admin
    .from("vo_address_checks")
    .insert({
      case_id: id,
      checked_at: `${body.checked_on}T12:00:00+05:30`,
      day_offset: dayOffsetFrom(row.lapsed_at, body.checked_on),
      source: body.source,
      result: body.note,
      verdict,
      evidence_ref: body.evidence_ref || null,
      checked_by: dbUser.id,
      raw: { finding: body.finding, entered_manually: true },
    })
    .select(CHECK_COLUMNS)
    .single();
  if (error) {
    if (isMissingSchema(error)) return NextResponse.json(NOT_READY, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "address_check_recorded" },
      source: { old: null, new: body.source },
      finding: { old: null, new: body.finding },
      verdict: { old: null, new: verdict },
    },
  });
  return NextResponse.json({ data: inserted }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;
  if (!ADDRESS_EVIDENCE_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager or accounts can release an address" }, { status: 403 });
  }
  const parsed = addressReleaseSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const admin = await createAdminClient();
  const { data: checks, error: checksError } = await admin
    .from("vo_address_checks")
    .select("checked_at, verdict, raw")
    .eq("case_id", id);
  if (checksError) {
    if (isMissingSchema(checksError)) return NextResponse.json(NOT_READY, { status: 503 });
    return NextResponse.json({ error: checksError.message }, { status: 500 });
  }
  const list = (checks ?? []) as { checked_at: string; verdict: "in_use" | "likely" | "inconclusive" | "clear"; raw: unknown }[];
  const ready = isProofRecorded(list) ||
    releaseDecision(list.map((x) => ({ checkedAt: x.checked_at, verdict: x.verdict }))) === "ready";
  if (!ready) {
    return NextResponse.json(
      { error: "Release needs two clear checks at least 7 days apart, or recorded deregistration proof." },
      { status: 409 },
    );
  }

  const { data: updated, error } = await admin
    .from("cases")
    .update({
      address_status: "released",
      address_released_at: new Date().toISOString(),
      address_release_reason: parsed.data.reason,
    })
    .eq("id", id)
    .eq("status", "lapsed")
    .select("id");
  if (error) {
    if (isMissingSchema(error)) return NextResponse.json(NOT_READY, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "Only a lapsed case can have its address released." }, { status: 409 });
  }

  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "address_released" },
      reason: { old: null, new: parsed.data.reason },
    },
  });
  return NextResponse.json({ data: { address_status: "released" } });
}
