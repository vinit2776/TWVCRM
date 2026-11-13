import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type { Flag } from "@/lib/vo-kyc-validators";
import {
  canPrepareKyc,
  canSignOffKyc,
  kycStep,
  allWarnings,
  type FlagAck,
  type KycReviewSnapshot,
  type PortalCheck,
} from "@/lib/vo-kyc-review";

/**
 * Are the KYC review columns and table in this database yet?
 *
 * Deploy comes before the migration is applied, so the routes must survive a
 * database that has neither. Same approach as waiverColumnsPresent() in
 * kyc-waiver.ts: 42703 (unknown column) and 42P01 (unknown table) mean "not
 * migrated yet"; any other error proves nothing, so it is reported as
 * unavailable without caching.
 */
let cached: { value: boolean; at: number } | null = null;
const NEGATIVE_TTL_MS = 60_000;

export async function kycReviewPresent(): Promise<boolean> {
  if (cached?.value) return true;
  if (cached && Date.now() - cached.at < NEGATIVE_TTL_MS) return false;

  try {
    const admin = await createAdminClient();
    const cols = await admin.from("cases").select("kyc_reviewed_at").limit(1);
    const table = await admin.from("case_kyc_portal_checks").select("id").limit(1);

    if (!cols.error && !table.error) {
      cached = { value: true, at: Date.now() };
      return true;
    }
    const missing = (e: { code?: string } | null) =>
      ["42703", "42P01", "PGRST204", "PGRST205"].includes(e?.code ?? "");
    if (missing(cols.error) || missing(table.error)) {
      cached = { value: false, at: Date.now() };
      return false;
    }
    console.error("[vo-kyc-review] probe failed:", cols.error?.message ?? table.error?.message);
    return false;
  } catch (err) {
    console.error("[vo-kyc-review] probe threw:", err);
    return false;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authoriseKyc(opts: { need: "view" | "prepare" | "signoff" }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const u = dbUser as { id: string; role: string; full_name: string | null };
  if (opts.need === "prepare" && !canPrepareKyc(u.role)) {
    return { error: NextResponse.json({ error: "You cannot run KYC checks" }, { status: 403 }) };
  }
  if (opts.need === "signoff" && !canSignOffKyc(u.role)) {
    return { error: NextResponse.json({ error: "Only an admin or manager can sign off KYC" }, { status: 403 }) };
  }
  return { dbUser: u };
}

export const NOT_MIGRATED = () =>
  NextResponse.json({ error: "KYC review is not available yet" }, { status: 503 });

export interface KycCaseRow {
  id: string;
  client_name: string;
  client_entity_type: string;
  client_company_name: string | null;
  client_gst_number: string | null;
  client_pan_number: string | null;
  client_cin_number: string | null;
  kyc_flags: Flag[] | null;
  kyc_checks_run_at: string | null;
  kyc_checks_run_by: string | null;
  kyc_signoff_acks: FlagAck[] | null;
  kyc_reviewed_at: string | null;
  kyc_reviewed_by: string | null;
}

export const KYC_CASE_SELECT =
  "id, client_name, client_entity_type, client_company_name, client_gst_number, client_pan_number, client_cin_number, kyc_flags, kyc_checks_run_at, kyc_checks_run_by, kyc_signoff_acks, kyc_reviewed_at, kyc_reviewed_by";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- admin client is untyped across the codebase
export async function loadKycState(admin: any, caseId: string) {
  const { data: c } = await admin.from("cases").select(KYC_CASE_SELECT).eq("id", caseId).maybeSingle();
  if (!c) return null;
  const row = c as KycCaseRow;
  const { data: checks } = await admin
    .from("case_kyc_portal_checks")
    .select("check_type, result, evidence_note, checked_at, checked_by")
    .eq("case_id", caseId)
    .order("checked_at", { ascending: false });
  const portalChecks = (checks ?? []) as PortalCheck[];
  const snapshot: KycReviewSnapshot = {
    checksRunAt: row.kyc_checks_run_at,
    reviewedAt: row.kyc_reviewed_at,
    flags: row.kyc_flags ?? [],
    portalChecks,
  };
  return { row, portalChecks, snapshot, step: kycStep(snapshot), warnings: allWarnings(snapshot.flags, portalChecks) };
}
