import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENTITY_TYPES, VO_TERM_DOCUMENTS, VO_TERM_PURPOSES } from "@/lib/constants";
import { isMissingTermsTable as isMissingTable } from "@/lib/vo-terms";

// Deploy precedes the hand-applied migration, so a missing table is a normal state, not a failure.

const READ_ROLES = ["admin", "manager", "sales_rep"];

const VERSION_COLUMNS =
  "id, clause_id, version, body, documents, purposes, company_types, min_term_months, is_current, reason, approved_by, approved_at, created_by, created_at";

async function currentUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, me: null as null, unauthorized: true };
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return { supabase, me, unauthorized: false };
}

// GET /api/admin/vo-terms: every clause with its current version.
// GET /api/admin/vo-terms?history=T05: every version of one clause, newest first.
export async function GET(request: NextRequest) {
  const { supabase, me, unauthorized } = await currentUser();
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me || !READ_ROLES.includes(me.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const history = request.nextUrl.searchParams.get("history");

  if (history) {
    const { data: clause, error: cErr } = await supabase
      .from("vo_clauses")
      .select("id, code, title")
      .eq("code", history)
      .maybeSingle();
    if (cErr) {
      if (isMissingTable(cErr)) return NextResponse.json({ data: [], notSetUp: true });
      return NextResponse.json({ error: cErr.message }, { status: 500 });
    }
    if (!clause) return NextResponse.json({ error: "Clause not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("vo_clause_versions")
      .select(VERSION_COLUMNS)
      .eq("clause_id", clause.id)
      .order("version", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ clause, data: data ?? [] });
  }

  const { data: clauses, error } = await supabase
    .from("vo_clauses")
    .select("id, code, title")
    .order("code");
  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ data: [], notSetUp: true });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: versions, error: vErr } = await supabase
    .from("vo_clause_versions")
    .select(VERSION_COLUMNS)
    .eq("is_current", true);
  if (vErr) {
    if (isMissingTable(vErr)) return NextResponse.json({ data: [], notSetUp: true });
    return NextResponse.json({ error: vErr.message }, { status: 500 });
  }

  const byClause = new Map((versions ?? []).map((v) => [v.clause_id as string, v]));
  const data = (clauses ?? []).map((c) => ({ ...c, current: byClause.get(c.id) ?? null }));
  return NextResponse.json({ data, notSetUp: false });
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("new_version"),
    code: z.string().min(1).max(20),
    body: z.string().trim().min(1).max(5000),
    documents: z.array(z.enum(VO_TERM_DOCUMENTS)).min(1),
    purposes: z.array(z.enum(VO_TERM_PURPOSES)).min(1),
    company_types: z.array(z.enum(ENTITY_TYPES)).min(1),
    min_term_months: z.number().int().min(1).max(120).nullable(),
    reason: z.string().trim().min(1).max(1000),
  }),
  z.object({
    action: z.literal("approve"),
    version_id: z.string().uuid(),
  }),
]);

// POST /api/admin/vo-terms: admin saves a new version of a clause, or approves a version.
export async function POST(request: NextRequest) {
  const { supabase, me, unauthorized } = await currentUser();
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "Only admin can change the terms library" }, { status: 403 });
  }

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const admin = createAdminClient();
  const input = parsed.data;

  if (input.action === "new_version") {
    const { data: clause, error: cErr } = await admin
      .from("vo_clauses")
      .select("id, code")
      .eq("code", input.code)
      .maybeSingle();
    if (cErr) {
      if (isMissingTable(cErr)) {
        return NextResponse.json({ error: "The terms library is not set up yet" }, { status: 503 });
      }
      return NextResponse.json({ error: cErr.message }, { status: 500 });
    }
    if (!clause) return NextResponse.json({ error: "Clause not found" }, { status: 404 });

    const { data: previous } = await admin
      .from("vo_clause_versions")
      .select("version")
      .eq("clause_id", clause.id)
      .eq("is_current", true)
      .maybeSingle();

    const { data: newId, error } = await admin.rpc("vo_clause_new_version", {
      p_clause_id: clause.id,
      p_body: input.body,
      p_documents: input.documents,
      p_purposes: input.purposes,
      p_company_types: input.company_types,
      p_min_term_months: input.min_term_months,
      p_reason: input.reason,
      p_created_by: me.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "vo_clause",
      entityId: clause.id,
      action: "update",
      performedBy: me.id,
      changes: {
        version: { old: previous?.version ?? null, new: (previous?.version ?? 0) + 1 },
        code: { old: null, new: clause.code },
        reason: { old: null, new: input.reason },
      },
    });
    return NextResponse.json({ ok: true, version_id: newId });
  }

  // Approval. There is no separate legal-reviewer role yet, so admin approves on legal's behalf.
  // When one exists, gate this branch on that role instead.
  const { data: version, error: fErr } = await admin
    .from("vo_clause_versions")
    .select("id, clause_id, version, is_current, approved_at")
    .eq("id", input.version_id)
    .maybeSingle();
  if (fErr) {
    if (isMissingTable(fErr)) {
      return NextResponse.json({ error: "The terms library is not set up yet" }, { status: 503 });
    }
    return NextResponse.json({ error: fErr.message }, { status: 500 });
  }
  if (!version) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  if (!version.is_current) {
    return NextResponse.json({ error: "Only the current version can be approved" }, { status: 409 });
  }
  if (version.approved_at) {
    return NextResponse.json({ error: "This version is already approved" }, { status: 409 });
  }

  const approvedAt = new Date().toISOString();
  const { error } = await admin
    .from("vo_clause_versions")
    .update({ approved_by: me.id, approved_at: approvedAt })
    .eq("id", version.id)
    .is("approved_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "vo_clause",
    entityId: version.clause_id,
    action: "update",
    performedBy: me.id,
    changes: {
      approved_at: { old: null, new: approvedAt },
      version: { old: null, new: version.version },
    },
  });
  return NextResponse.json({ ok: true });
}
