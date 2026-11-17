import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import {
  describeSyncReport,
  syncStatementsForAddonChange,
  type AddonSyncReport,
} from "@/lib/contract-addon-server";
import type { AddonTerms } from "@/lib/addon-billing";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const addonSchema = z.object({
  description: z.string().min(1).max(200),
  amount: z.number().positive(),
  effective_from: ymd,
  effective_until: ymd.optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

const patchSchema = z.object({
  addon_id: z.string().uuid("addon_id required"),
  description: z.string().trim().min(1).max(200).optional(),
  amount: z.number().positive().optional(),
  effective_from: ymd.optional(),
  effective_until: ymd.nullable().optional(),
  is_active: z.boolean().optional(),
  end_reason: z.string().trim().max(500).optional(),
});

/** Same roles that manage contracts; ending an add-on early is a change to what the customer pays. */
const END_BILLING_ROLES = ["admin", "manager", "sales_rep"];
const MIN_END_REASON_LENGTH = 10;

const toTerms = (row: Record<string, unknown>): AddonTerms => ({
  description: String(row.description),
  amount: Number(row.amount),
  effective_from: String(row.effective_from),
  effective_until: (row.effective_until as string | null) ?? null,
  is_active: row.is_active !== false,
});

/** Dates must sit inside the contract term and run forwards. Returns a message, or null when fine. */
function addonDateError(
  from: string,
  until: string | null,
  term: { start_date?: string | null; end_date?: string | null }
): string | null {
  if (term.start_date && from < term.start_date) return `Effective from cannot be before the contract start date (${term.start_date})`;
  if (term.end_date && from > term.end_date) return `Effective from cannot be after the contract end date (${term.end_date})`;
  if (until) {
    if (term.end_date && until > term.end_date) return `Effective until cannot be beyond the contract end date (${term.end_date})`;
    if (until < from) return "Effective until must be after effective from";
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_addons")
    .select("*")
    .eq("contract_id", id)
    .order("effective_from", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const result = addonSchema.safeParse(body);
  if (!result.success) return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const adminSupabase = createAdminClient();
  const { data: contract } = await adminSupabase
    .from("contracts")
    .select("start_date, end_date")
    .eq("id", id)
    .maybeSingle();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const dateError = addonDateError(result.data.effective_from, result.data.effective_until ?? null, contract);
  if (dateError) return NextResponse.json({ error: dateError }, { status: 400 });

  const { data, error } = await adminSupabase
    .from("contract_addons")
    .insert({
      contract_id: id,
      description: result.data.description,
      amount: result.data.amount,
      effective_from: result.data.effective_from,
      effective_until: result.data.effective_until ?? null,
      is_active: result.data.is_active,
      created_by: dbUser?.id ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Unsent drafts that fall in the add-on's dates are corrected; anything
  // already issued is never touched, only reported back.
  const drafts = await syncStatementsForAddonChange(adminSupabase, id, null, toTerms(data));

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser?.id ?? "",
    changes: { addon_added: { old: null, new: result.data.description } },
  });

  return NextResponse.json({ data, drafts, notice: describeSyncReport(drafts) }, { status: 201 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const { addon_id, end_reason, ...fields } = parsed.data;

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  const adminSupabase = createAdminClient();
  const { data: existing } = await adminSupabase
    .from("contract_addons")
    .select("*")
    .eq("id", addon_id)
    .eq("contract_id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Add-on not found on this contract" }, { status: 404 });

  const { data: contract } = await adminSupabase
    .from("contracts")
    .select("start_date, end_date")
    .eq("id", id)
    .maybeSingle();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const before = toTerms(existing);
  const after: AddonTerms = {
    description: fields.description ?? before.description,
    amount: fields.amount ?? before.amount,
    effective_from: fields.effective_from ?? before.effective_from,
    effective_until: fields.effective_until !== undefined ? fields.effective_until : before.effective_until,
    is_active: fields.is_active ?? before.is_active,
  };

  // Dates are only checked when this request changes them, so an add-on that
  // predates the check can still be paused or renamed.
  if (fields.effective_from !== undefined || fields.effective_until !== undefined) {
    const dateError = addonDateError(after.effective_from, after.effective_until, contract);
    if (dateError) return NextResponse.json({ error: dateError }, { status: 400 });
  }

  // Stopping billing before the add-on was due to run out changes what the
  // customer pays: it needs a role that manages contracts, and a reason on record.
  const endsEarly = after.effective_until !== null && after.effective_until < (before.effective_until ?? contract.end_date ?? "9999-12-31");
  if (endsEarly) {
    if (!END_BILLING_ROLES.includes(dbUser?.role ?? "")) {
      return NextResponse.json({ error: "Only admins, managers and sales reps can end an add-on early." }, { status: 403 });
    }
    if ((end_reason ?? "").length < MIN_END_REASON_LENGTH) {
      return NextResponse.json({ error: `Say why billing is ending early (at least ${MIN_END_REASON_LENGTH} characters).` }, { status: 400 });
    }
  }

  const { data, error } = await adminSupabase
    .from("contract_addons")
    .update({
      description: after.description,
      amount: after.amount,
      effective_from: after.effective_from,
      effective_until: after.effective_until,
      is_active: after.is_active,
      updated_at: new Date().toISOString(),
    })
    .eq("id", addon_id)
    .eq("contract_id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const drafts: AddonSyncReport = await syncStatementsForAddonChange(adminSupabase, id, before, after);

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  (Object.keys(after) as (keyof AddonTerms)[]).forEach((key) => {
    if (before[key] !== after[key]) changes[`${before.description}: ${key}`] = { old: before[key], new: after[key] };
  });
  if (endsEarly) changes[`${before.description}: reason`] = { old: null, new: end_reason };
  if (Object.keys(changes).length > 0) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: endsEarly ? "contract_addon_ended" : "update",
      performedBy: dbUser?.id ?? "",
      changes,
    });
  }

  return NextResponse.json({ data, drafts, notice: describeSyncReport(drafts) });
}
