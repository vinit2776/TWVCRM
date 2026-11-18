import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  PROPOSAL_TERMS_SELECT,
  assembleProposalTerms,
  getVoTermsMode,
  isNotMigrated,
} from "@/lib/vo-terms-server";

const ROLES = ["admin", "manager", "sales_rep"];

/**
 * GET /api/proposals/[id]/vo-terms
 * Read-only. Which library clauses this VO proposal carries: the frozen snapshot if it has
 * been sent, otherwise a live preview, plus any applicable clause legal has not approved.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const mode = await getVoTermsMode(admin);
  if (mode !== "on") return NextResponse.json({ data: { mode, clauses: [], warnings: [], frozen: false } });

  const { data: proposal, error } = await admin.from("proposals").select(PROPOSAL_TERMS_SELECT).eq("id", id).maybeSingle();
  if (error || !proposal || proposal.kind !== "virtual_office") {
    return NextResponse.json({ error: "Virtual Office proposal not found" }, { status: 404 });
  }

  // Own query: before migration 00690 the column is missing.
  const { data: snapRow, error: snapErr } = await admin.from("proposals").select("vo_terms_snapshot").eq("id", id).maybeSingle();
  if (snapErr && !isNotMigrated(snapErr.code)) return NextResponse.json({ error: snapErr.message }, { status: 500 });
  const frozen = (snapRow?.vo_terms_snapshot as { clauses?: { code: string; version: number; text: string }[] } | null) ?? null;

  const live = await assembleProposalTerms(admin, proposal as never);
  if (!live) return NextResponse.json({ data: { mode, clauses: [], warnings: [], frozen: false, notSetUp: true } });

  return NextResponse.json({
    data: {
      mode,
      frozen: !!frozen?.clauses?.length,
      // Once sent, the issued text is what counts; warnings always describe the live library.
      clauses: (frozen?.clauses?.length ? frozen.clauses : live.clauses).map((c) => ({ code: c.code, version: c.version, text: c.text })),
      warnings: live.warnings,
    },
  });
}
