import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getActor } from "@/lib/addendum/server";
import { clientIp, loadNocSettings, recordNocEvent } from "@/lib/noc/server";
import {
  canOrderNoc, canOrderOnContract, computeFee, nocReference, PURPOSE_LABELS, validateOrder, type NocPurpose,
} from "@/lib/noc/rules";

const OPEN = ["draft", "sent", "accepted", "paid", "issued"];

/**
 * GET /api/contracts/[id]/noc
 * The contract's NOC orders plus what the order form needs (active centres, the fee). When the feature is off
 * it answers { enabled: false } and nothing else, so the screens show nothing at all.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;

  const admin = createAdminClient();
  const settings = await loadNocSettings(admin);
  if (!settings.enabled) return NextResponse.json({ data: { enabled: false } });

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, status, end_date, location_id, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const { data: nocs } = await supabase
    .from("noc_requests")
    .select("*, location:locations!noc_requests_location_id_fkey(id, name)")
    .eq("contract_id", id)
    .order("sequence_in_contract", { ascending: true });

  const { data: centres } = await supabase
    .from("locations")
    .select("id, name, address, city, state, noc_address")
    .eq("is_active", true)
    .order("name");

  const lead = (Array.isArray(contract.lead) ? contract.lead[0] : contract.lead) as { company?: string; first_name?: string; last_name?: string } | null;
  return NextResponse.json({
    data: {
      enabled: true,
      contract: { id: contract.id, contract_number: contract.contract_number, status: contract.status, end_date: contract.end_date, location_id: contract.location_id, orderable: canOrderOnContract(contract.status) },
      suggestedCompany: lead?.company?.trim() || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim(),
      nocs: (nocs ?? []).map((n) => ({ ...n, reference: nocReference(contract.contract_number, n.sequence_in_contract) })),
      centres: (centres ?? []).map((c) => ({ id: c.id, name: c.name, hasNocAddress: !!c.noc_address?.trim(), hasAddress: [c.address, c.city, c.state].some((v) => !!v?.trim()) })),
      fees: { roc: computeFee(settings.feeRoc, settings.taxPercentage), gst: computeFee(settings.feeGst, settings.taxPercentage), taxPercentage: settings.taxPercentage },
    },
  });
}

const orderSchema = z.object({
  purpose: z.string(),
  locationId: z.string().uuid("Choose the centre."),
  companyName: z.string().trim().min(1, "Enter the company's name as it should appear on the NOC."),
  cin: z.string().trim().optional(),
});

/** POST /api/contracts/[id]/noc: creates a draft order. Contacts nobody and takes no money. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;
  if (!canOrderNoc(actor.role)) return NextResponse.json({ error: "Your role cannot order a NOC" }, { status: 403 });

  const admin = createAdminClient();
  const settings = await loadNocSettings(admin);
  if (!settings.enabled) return NextResponse.json({ error: "The NOC service is not switched on yet." }, { status: 403 });

  const parsed = orderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const input = parsed.data;
  const problems = validateOrder({ purpose: input.purpose, locationId: input.locationId, companyName: input.companyName, cin: input.cin });
  if (problems.length) return NextResponse.json({ error: problems[0], errors: problems }, { status: 400 });
  const purpose = input.purpose as NocPurpose;

  const { data: contract } = await admin
    .from("contracts")
    .select("id, contract_number, status, lead_id")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!canOrderOnContract(contract.status)) {
    return NextResponse.json({ error: `A ${contract.status} contract cannot take a NOC.` }, { status: 400 });
  }

  const { data: centre } = await admin
    .from("locations")
    .select("id, name, address, city, state, noc_address, is_active")
    .eq("id", input.locationId)
    .single();
  if (!centre || !centre.is_active) return NextResponse.json({ error: "Choose an active centre." }, { status: 400 });
  const fallback = [centre.address, centre.city, centre.state].map((s) => s?.trim()).filter(Boolean).join(", ");
  const address = centre.noc_address?.trim() || fallback;
  if (!address) {
    return NextResponse.json({ error: `${centre.name} has no address on file. Add it under Locations, then order again.` }, { status: 400 });
  }

  const { data: existing } = await admin
    .from("noc_requests")
    .select("sequence_in_contract, purpose, location_id, status")
    .eq("contract_id", id);
  const duplicate = (existing ?? []).find((n) => n.purpose === purpose && n.location_id === centre.id && OPEN.includes(n.status));
  if (duplicate) {
    return NextResponse.json({ error: `A ${PURPOSE_LABELS[purpose]} NOC for ${centre.name} is already on this contract. Void it first if it needs redoing.` }, { status: 409 });
  }
  const sequence = Math.max(0, ...(existing ?? []).map((n) => n.sequence_in_contract)) + 1;
  const fee = purpose === "roc" ? settings.feeRoc : settings.feeGst;

  const { data: row, error } = await admin
    .from("noc_requests")
    .insert({
      contract_id: id, sequence_in_contract: sequence, lead_id: contract.lead_id, purpose, location_id: centre.id,
      company_name: input.companyName.trim(), cin: input.cin?.trim().toUpperCase() || null, noc_address: address,
      fee_excl_gst: fee, tax_percentage: settings.taxPercentage, status: "draft", created_by: actor.id,
    })
    .select("*")
    .single();
  if (error || !row) {
    if (error?.code === "23505") return NextResponse.json({ error: "Someone just ordered a NOC on this contract. Reload and try again." }, { status: 409 });
    return NextResponse.json({ error: error?.message ?? "Could not create the NOC order" }, { status: 500 });
  }

  await recordNocEvent(admin, row.id, "order_created", {
    actorId: actor.id, actorLabel: actor.name, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent"),
    detail: { purpose, centre: centre.name, company: row.company_name, fee_excl_gst: fee, tax_percentage: settings.taxPercentage, text_version: "NOC-T1", reference: nocReference(contract.contract_number, sequence) },
  });
  logAudit(admin, {
    entityType: "contract", entityId: id, action: "update", performedBy: actor.id,
    changes: { noc_ordered: { old: null, new: `${row.noc_number} · ${PURPOSE_LABELS[purpose]} · ${centre.name}` } },
  });
  return NextResponse.json({ data: { ...row, reference: nocReference(contract.contract_number, sequence) } }, { status: 201 });
}
