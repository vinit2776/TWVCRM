import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getActor } from "@/lib/addendum/server";
import {
  buildChangeOfNameText, canAuthorAddendum, validateParams, type ChangeOfNameParams,
} from "@/lib/addendum/change-of-name";

const CLOSED_CONTRACT = ["rejected", "terminated", "completed", "expired", "draft", "cancelled"];

/**
 * GET /api/contracts/[id]/addenda
 * The contract's addenda, plus what the create form needs: the customer's current
 * details and any other live contract that shares the same customer record.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, status, lead_id, start_date, accepted_at, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, gst_number, pan_number, entity_type, city, state)")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const { data: addenda } = await supabase
    .from("contract_addenda")
    .select("*, created_by_user:users!contract_addenda_created_by_fkey(full_name), decided_by_user:users!contract_addenda_decided_by_fkey(full_name)")
    .eq("contract_id", id)
    .order("addendum_number", { ascending: true });

  const { data: others } = await supabase
    .from("contracts")
    .select("id, contract_number, status")
    .eq("lead_id", contract.lead_id)
    .neq("id", id)
    .in("status", ["active", "renewal_in_progress", "accepted", "sent", "viewed"]);

  return NextResponse.json({
    data: { addenda: addenda ?? [], contract, otherContracts: others ?? [] },
  });
}

const createSchema = z.object({
  purpose: z.literal("change_of_name"),
  reason: z.string().trim().min(5, "Say why this is needed"),
  params: z.object({
    kind: z.enum(["same_entity", "new_entity"]),
    newName: z.string().trim().min(1),
    entityType: z.string().trim().min(1),
    gstin: z.string().trim().default(""),
    pan: z.string().trim().default(""),
    cin: z.string().trim().default(""),
    registeredAddress: z.string().trim().default(""),
    signatoryName: z.string().trim().min(1),
    signatoryDesignation: z.string().trim().default(""),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    depositCarriesOver: z.boolean(),
    companyTakesEarlierDues: z.boolean(),
    outgoingAddress: z.string().trim().default(""),
    outgoingIsEntity: z.boolean().default(false),
    outgoingSignatoryName: z.string().trim().default(""),
    outgoingSignatoryDesignation: z.string().trim().default(""),
    docsHeld: z.array(z.string()).default([]),
  }),
});

/** POST /api/contracts/[id]/addenda: starts a draft from the template for the chosen case. Sends nobody anything. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;
  if (!canAuthorAddendum(actor.role)) return NextResponse.json({ error: "Your role cannot create an addendum" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const { reason, params: p } = parsed.data;

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, status, start_date, accepted_at, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (CLOSED_CONTRACT.includes(contract.status)) {
    return NextResponse.json({ error: `A ${contract.status} contract cannot take an addendum.` }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: open } = await admin
    .from("contract_addenda")
    .select("addendum_number")
    .eq("contract_id", id)
    .eq("purpose", "change_of_name")
    .not("status", "in", "(applied,withdrawn)");
  if (open && open.length > 0) {
    return NextResponse.json({ error: `Addendum ${open[0].addendum_number} (change of name) is still open. Finish or withdraw it first.` }, { status: 409 });
  }

  const lead = (Array.isArray(contract.lead) ? contract.lead[0] : contract.lead) as { first_name?: string; last_name?: string; company?: string } | null;
  const outgoingName = lead?.company?.trim() || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim();
  const full: ChangeOfNameParams = {
    ...p,
    outgoingName,
    agreementDate: (contract.accepted_at ?? contract.start_date ?? "").toString().slice(0, 10),
    contractNumber: contract.contract_number,
  };
  const errors = validateParams(full);
  if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

  const { data: last } = await admin
    .from("contract_addenda")
    .select("addendum_number")
    .eq("contract_id", id)
    .order("addendum_number", { ascending: false })
    .limit(1);
  const number = (last?.[0]?.addendum_number ?? 0) + 1;
  const text = buildChangeOfNameText(full, number);

  const { data: row, error } = await admin
    .from("contract_addenda")
    .insert({
      contract_id: id, addendum_number: number, purpose: "change_of_name", status: "draft",
      params: full, reason, current_text: text, revision: 1, created_by: actor.id,
    })
    .select("*")
    .single();
  if (error || !row) return NextResponse.json({ error: error?.message ?? "Could not create the addendum" }, { status: 500 });

  await admin.from("contract_addendum_revisions").insert({ addendum_id: row.id, revision: 1, text, source: "template", created_by: actor.id });
  logAudit(admin, {
    entityType: "contract", entityId: id, action: "update", performedBy: actor.id,
    changes: { addendum_created: { old: null, new: `ADD-${number} (change of name)` } },
  });
  return NextResponse.json({ data: row }, { status: 201 });
}
