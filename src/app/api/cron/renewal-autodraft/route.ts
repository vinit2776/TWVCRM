import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createRenewalDraft } from "@/lib/renewal-draft";
import { logAudit } from "@/lib/audit";
import { withCronHealth } from "@/lib/cron-ping";
import { managersFor, notifyDraftReady, type Person } from "@/lib/renewal-notices";
import {
  AUTODRAFT_WINDOW_DAYS,
  needsValidationNudge,
  selectAutodraftTargets,
  type AutodraftCandidate,
} from "@/lib/renewal-autodraft";

export const maxDuration = 60;

/**
 * GET /api/cron/renewal-autodraft
 *
 * Daily (10:00 IST). When a contract is within 45 days of its end date and has
 * no renewal yet, creates the renewal draft exactly as the Renew button would,
 * marks it auto-created (it must be validated by a person before it can be
 * sent) and tells the rep and the location's managers. At most 5 drafts per
 * run, soonest-ending first, so switching it on does not draft the whole book
 * at once. A second pass nudges staff once when a draft is still unvalidated
 * after 7 days. Staff only: nothing here is sent to a customer.
 *
 * Ships dark: app_settings.renewal_autodraft_enabled must be 'true'.
 */

type ContractRow = AutodraftCandidate & {
  contract_number: string;
  created_by: string | null;
  location_id: string | null;
  lead: { first_name: string | null; last_name: string | null; company: string | null; assigned_to: string | null } | null;
};

function customerName(lead: ContractRow["lead"]): string {
  return lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "Customer";
}

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: setting } = await admin
    .from("app_settings").select("value").eq("key", "renewal_autodraft_enabled").maybeSingle();
  if (setting?.value !== "true") {
    return NextResponse.json({ skipped: "renewal_autodraft_enabled is off" });
  }

  const now = new Date();
  const todayIst = new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const horizon = new Date(new Date(`${todayIst}T00:00:00Z`).getTime() + AUTODRAFT_WINDOW_DAYS * 86_400_000)
    .toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("contracts")
    .select("id, contract_number, end_date, status, renewal_declined, created_by, location_id, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, assigned_to)")
    .eq("status", "active")
    .eq("renewal_declined", false)
    .gte("end_date", todayIst)
    .lte("end_date", horizon);
  if (error) {
    console.error("[renewal-autodraft] fetch error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const contracts = (data ?? []) as unknown as ContractRow[];

  const { data: existing } = await admin
    .from("contracts")
    .select("parent_contract_id")
    .in("parent_contract_id", contracts.length ? contracts.map((c) => c.id) : ["00000000-0000-0000-0000-000000000000"])
    .eq("is_renewal", true)
    .not("status", "in", '("terminated","rejected")');
  const renewed = new Set((existing ?? []).map((r) => r.parent_contract_id as string));

  const targets = selectAutodraftTargets(contracts, renewed, todayIst) as ContractRow[];
  const tally = { eligible: contracts.length - renewed.size, drafted: 0, failed: 0, nudged: 0 };

  const personCache = new Map<string, Person>();
  const person = async (id: string | null | undefined): Promise<Person | null> => {
    if (!id) return null;
    if (!personCache.has(id)) {
      const { data: u } = await admin.from("users").select("id, full_name, email").eq("id", id).maybeSingle();
      if (u) personCache.set(id, u as Person);
    }
    return personCache.get(id) ?? null;
  };

  for (const c of targets) {
    try {
      const rep = (await person(c.lead?.assigned_to)) ?? (await person(c.created_by));
      const result = await createRenewalDraft(
        admin, c.id, { id: rep?.id ?? null, role: "system", full_name: null, system: true }, {}, true
      );
      if (!result.ok) {
        console.error("[renewal-autodraft] skipped", c.contract_number, result.error);
        tally.failed++;
        continue;
      }
      tally.drafted++;
      logAudit(admin, {
        entityType: "contract", entityId: result.data.id, action: "update", performedBy: "system",
        changes: { renewal_auto_created: { old: false, new: true } },
      });
      await notifyDraftReady(admin, {
        contractId: c.id, parentNumber: c.contract_number, draftId: result.data.id,
        draftNumber: result.data.contract_number, customer: customerName(c.lead), endDate: c.end_date,
        escalationPct: result.data.escalation_percentage, newSubtotal: result.data.new_subtotal,
        rep, managers: await managersFor(admin, c.location_id), reminder: false,
      });
    } catch (err) {
      console.error("[renewal-autodraft] failed", c.contract_number, err);
      tally.failed++;
    }
  }

  // Second pass: auto-drafts nobody has validated after a week.
  const { data: stale } = await admin
    .from("contracts")
    .select("id, contract_number, parent_contract_id, subtotal, escalation_percentage, created_by, location_id, renewal_auto_created_at, renewal_validated_at, renewal_validation_nudged_at, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, assigned_to)")
    .eq("renewal_auto_created", true)
    .eq("status", "draft")
    .is("renewal_validated_at", null)
    .is("renewal_validation_nudged_at", null);
  for (const d of (stale ?? []) as unknown as (ContractRow & {
    parent_contract_id: string; subtotal: number; escalation_percentage: number;
    renewal_auto_created_at: string | null; renewal_validated_at: string | null; renewal_validation_nudged_at: string | null;
  })[]) {
    if (!needsValidationNudge(d, now)) continue;
    const { data: claimed } = await admin
      .from("contracts").update({ renewal_validation_nudged_at: now.toISOString() })
      .eq("id", d.id).is("renewal_validation_nudged_at", null).select("id");
    if (!claimed || claimed.length === 0) continue;
    const { data: parent } = await admin.from("contracts").select("contract_number, end_date").eq("id", d.parent_contract_id).maybeSingle();
    const rep = (await person(d.lead?.assigned_to)) ?? (await person(d.created_by));
    await notifyDraftReady(admin, {
      contractId: d.parent_contract_id, parentNumber: parent?.contract_number ?? "", draftId: d.id,
      draftNumber: d.contract_number, customer: customerName(d.lead), endDate: parent?.end_date ?? "",
      escalationPct: Number(d.escalation_percentage ?? 0), newSubtotal: Number(d.subtotal ?? 0),
      rep, managers: await managersFor(admin, d.location_id), reminder: true,
    });
    tally.nudged++;
  }

  return NextResponse.json({ checked: contracts.length, ...tally });
}

export const GET = withCronHealth("cron/renewal-autodraft", handler);
