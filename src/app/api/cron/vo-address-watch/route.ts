import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { logAudit } from "@/lib/audit";
import {
  CHECK_INTERVAL_DAYS,
  VO_ADDRESS_WATCH_MODE_SETTING,
  VO_HOLDOVER_SETTING_KEYS,
  parseHoldoverSettings,
  parseWatchMode,
  type AddressVerdict,
} from "@/lib/vo-address-watch";
import { isMissingSchema, isProofRecorded } from "@/lib/vo-address-evidence";
import {
  VO_HOLDOVER_CLAUSE_APPROVED_SETTING,
  createHoldoverDraft,
  cycleFromReference,
  daysSinceLapse,
  decideHoldover,
  holdoverReference,
  isHoldoverClauseApproved,
  type HoldoverCase,
} from "@/lib/vo-holdover-pi";

/**
 * VO address watch cron. After a case has lapsed, finds the ones whose address
 * may still be in use and works out which holdover proforma is due.
 *
 * It never contacts a customer. In live mode its only write is a holdover
 * proforma DRAFT (billing_statements, status draft) for a person to review,
 * finalize and send. Every period is created at most once per case.
 *
 * MODE (app_settings.vo_address_watch_mode): off (default; a missing value) /
 * dry_run (reports what it WOULD do, writes nothing) / live. The URL can only
 * make a run more cautious, never live.
 *
 * Even in live mode no draft is created until legal has approved the holdover
 * clause (app_settings.vo_holdover_clause_approved = 'true'); until then the
 * run only reports what is blocked.
 *
 * Deploys before its migrations (00680, 00689): missing tables or columns are
 * reported as "not migrated yet", not as failures.
 */

const CASE_SELECT =
  "id, case_number, client_name, client_company_name, rate, tenure_months, lapsed_at, aggregator_id, client_gst_number, location:locations!cases_location_id_fkey(name)";

interface CaseRow extends HoldoverCase {
  client_name: string;
  client_company_name: string | null;
  aggregator_id: string | null;
  address_status?: string | null;
}

interface CheckRow {
  case_id: string;
  checked_at: string;
  verdict: AddressVerdict;
  raw: unknown;
}

function todayIst(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

async function loadLapsedCases(admin: SupabaseClient): Promise<{ rows: CaseRow[]; notMigrated: boolean; error?: string }> {
  const withStatus = await admin
    .from("cases")
    .select(`${CASE_SELECT}, address_status`)
    .eq("status", "lapsed")
    .not("lapsed_at", "is", null);
  if (!withStatus.error) return { rows: (withStatus.data ?? []) as unknown as CaseRow[], notMigrated: false };
  if (withStatus.error.code !== "42703") return { rows: [], notMigrated: false, error: withStatus.error.message };
  // address_status not migrated: every lapsed case is still being watched.
  const bare = await admin.from("cases").select(CASE_SELECT).eq("status", "lapsed").not("lapsed_at", "is", null);
  if (bare.error) return { rows: [], notMigrated: true, error: bare.error.message };
  return { rows: (bare.data ?? []) as unknown as CaseRow[], notMigrated: true };
}

async function handler(request: Request) {
  if (request.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await createAdminClient();
  const today = todayIst();
  const keys = [VO_ADDRESS_WATCH_MODE_SETTING, VO_HOLDOVER_CLAUSE_APPROVED_SETTING, ...Object.values(VO_HOLDOVER_SETTING_KEYS)];
  const settings = await getCachedSettings(admin, keys);
  let mode = parseWatchMode(settings[VO_ADDRESS_WATCH_MODE_SETTING]);
  // The URL can only make a run more cautious.
  if (new URL(request.url).searchParams.get("dry_run") === "1" && mode === "live") mode = "dry_run";
  if (mode === "off") {
    return NextResponse.json({ success: true, date: today, mode, skipped: "vo_address_watch_mode is off" });
  }
  const live = mode === "live";
  const clauseApproved = isHoldoverClauseApproved(settings[VO_HOLDOVER_CLAUSE_APPROVED_SETTING]);
  const holdover = parseHoldoverSettings(settings);

  const results = {
    mode,
    clauseApproved,
    wouldCreate: [] as string[],
    created: [] as string[],
    blocked: [] as string[],
    needsCheck: [] as string[],
    needsPerson: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
    notMigrated: [] as string[],
  };

  const { rows, notMigrated, error } = await loadLapsedCases(admin);
  if (error && !notMigrated) return NextResponse.json({ success: false, error }, { status: 500 });
  if (notMigrated) results.notMigrated.push("cases.address_status (migration 00680)");

  const cases = rows.filter((c) => c.address_status !== "released");
  const ids = cases.map((c) => c.id);

  const checksByCase = new Map<string, CheckRow[]>();
  const cyclesByCase = new Map<string, number[]>();
  let checksAvailable = true;
  if (ids.length > 0) {
    const checks = await admin.from("vo_address_checks").select("case_id, checked_at, verdict, raw").in("case_id", ids);
    if (checks.error) {
      if (!isMissingSchema(checks.error)) return NextResponse.json({ success: false, error: checks.error.message }, { status: 500 });
      checksAvailable = false;
      results.notMigrated.push("vo_address_checks (migration 00680)");
    }
    for (const r of (checks.data ?? []) as CheckRow[]) {
      const list = checksByCase.get(r.case_id) ?? [];
      list.push(r);
      checksByCase.set(r.case_id, list);
    }

    if (checksAvailable) {
      const stmts = await admin
        .from("billing_statements")
        .select("case_id, reference_note")
        .in("case_id", ids)
        .eq("statement_type", "vo_holdover")
        .not("status", "in", "(voided,discarded)");
      if (stmts.error) {
        if (!isMissingSchema(stmts.error)) return NextResponse.json({ success: false, error: stmts.error.message }, { status: 500 });
        results.notMigrated.push("billing_statements vo_holdover type (migration 00680)");
        checksAvailable = false;
      }
      for (const s of (stmts.data ?? []) as { case_id: string; reference_note: string | null }[]) {
        const n = cycleFromReference(s.reference_note);
        if (n !== null) cyclesByCase.set(s.case_id, [...(cyclesByCase.get(s.case_id) ?? []), n]);
      }
    }
  }

  if (checksAvailable) {
    for (const c of cases) {
      const tag = `${c.case_number} — ${c.client_company_name || c.client_name}`;
      try {
        if (c.aggregator_id) {
          // cases.rate on a partner case is not the customer's holdover base.
          results.needsPerson.push(`${tag} (billed through a partner; set the holdover by hand)`);
          continue;
        }
        const checks = (checksByCase.get(c.id) ?? []).sort((a, b) => a.checked_at.localeCompare(b.checked_at));
        const latest = checks.length ? checks[checks.length - 1] : null;
        const day = daysSinceLapse(c.lapsed_at, today);

        if (!latest) {
          if (day >= 7) results.needsCheck.push(`${tag} (day ${day}, no public-record check recorded)`);
          continue;
        }
        const staleDays = daysSinceLapse(latest.checked_at, today);
        if (staleDays > CHECK_INTERVAL_DAYS) results.needsCheck.push(`${tag} (last check ${staleDays} days ago)`);

        const decision = decideHoldover({
          lapsedAt: c.lapsed_at,
          today,
          latestVerdict: latest.verdict,
          released: false,
          proofVerified: isProofRecorded(checks),
          existingCycles: cyclesByCase.get(c.id) ?? [],
        });
        if (!decision.create) continue;

        const ref = holdoverReference(c.case_number, decision.cycle);
        if (!clauseApproved) {
          results.blocked.push(`${tag}: ${ref} is due but the holdover clause is not approved yet`);
          continue;
        }
        if (!live) {
          results.wouldCreate.push(`${tag}: would draft ${ref}`);
          continue;
        }
        const out = await createHoldoverDraft(admin, c, decision.cycle, holdover, today);
        if (out.outcome === "created") {
          results.created.push(`${tag}: drafted ${ref}`);
          logAudit(admin, {
            entityType: "case",
            entityId: c.id,
            action: "create",
            performedBy: "system",
            changes: { action: { old: null, new: "holdover_pi_drafted" }, reference: { old: null, new: ref } },
          });
        } else if (out.outcome === "exists") results.skipped.push(`${tag}: ${ref} already exists`);
        else if (out.outcome === "schema_missing") results.notMigrated.push("billing_statements vo_holdover type (migration 00680)");
        else results.errors.push(`${tag}: ${out.message}`);
      } catch (err) {
        results.errors.push(`${c.case_number}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log("[cron/vo-address-watch] Result:", JSON.stringify({ ...results, date: today }));
  return NextResponse.json({ success: true, date: today, watched: cases.length, ...results });
}

export const GET = withCronHealth("cron/vo-address-watch", handler);
