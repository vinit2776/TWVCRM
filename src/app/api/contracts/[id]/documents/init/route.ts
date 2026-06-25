import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { KYC_DOCUMENTS } from "@/lib/constants";

type Params = { params: Promise<{ id: string }> };

// POST — initialize KYC document slots based on lead's entity type.
// 1. Creates missing slots — carrying over approved/deferred docs from prior
//    contracts for the same lead instead of creating blank pending slots.
// 2. Updates existing pending slots — if a prior approved/deferred doc now
//    exists for the same label, upgrades the slot in place.
export async function POST(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch contract with lead id and entity_type
  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead:leads!contracts_lead_id_fkey(id, entity_type)")
    .eq("id", id)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const entityType = lead?.entity_type || "other";
  const requiredDocs = KYC_DOCUMENTS[entityType] || KYC_DOCUMENTS.other || [];

  if (requiredDocs.length === 0) {
    return NextResponse.json({ data: [], message: "No KYC documents required for this entity type" });
  }

  // Fetch all existing slots on this contract (full row needed for update logic)
  const { data: existing } = await supabase
    .from("contract_documents")
    .select("id, label, status, document_id")
    .eq("contract_id", id);

  // De-duplicate: keep one slot per label (first occurrence wins)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slotByLabel = new Map<string, any>();
  for (const row of existing || []) {
    if (!slotByLabel.has(row.label)) slotByLabel.set(row.label, row);
  }

  const missingLabels = (requiredDocs as string[]).filter((label) => !slotByLabel.has(label));
  // Pending slots that could be upgraded if a prior approved/deferred doc exists
  const pendingLabels = (requiredDocs as string[]).filter(
    (label) => slotByLabel.has(label) && slotByLabel.get(label).status === "pending" && !slotByLabel.get(label).document_id
  );
  const labelsToLookup = [...new Set([...missingLabels, ...pendingLabels])];

  // Find all other contracts for this lead
  const { data: leadContracts } = await supabase
    .from("contracts")
    .select("id")
    .eq("lead_id", lead?.id)
    .neq("id", id);

  const leadContractIds = (leadContracts || []).map((c) => c.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priorByLabel = new Map<string, any>();

  if (leadContractIds.length > 0 && labelsToLookup.length > 0) {
    const { data: priorDocs } = await supabase
      .from("contract_documents")
      .select(
        "label, document_id, document_type, is_required, status, reviewed_by, reviewed_at, notes, deferred_by, deferred_at, deferred_reason, deferred_until"
      )
      .in("status", ["approved", "deferred"])
      .in("label", labelsToLookup)
      .in("contract_id", leadContractIds)
      .order("reviewed_at", { ascending: false });

    for (const doc of priorDocs || []) {
      if (!priorByLabel.has(doc.label)) priorByLabel.set(doc.label, doc);
    }
  }

  // 1. Insert missing slots
  let created = 0;
  if (missingLabels.length > 0) {
    const toInsert = missingLabels.map((label) => {
      const prior = priorByLabel.get(label);
      if (prior?.document_id) {
        return {
          contract_id: id,
          document_id: prior.document_id,
          document_type: prior.document_type ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
          label,
          is_required: true,
          status: prior.status,
          reviewed_by: prior.reviewed_by ?? null,
          reviewed_at: prior.reviewed_at ?? null,
          notes: prior.notes ? `${prior.notes} [carried forward]` : "Carried forward from prior contract",
          ...(prior.status === "deferred"
            ? {
                deferred_by: prior.deferred_by ?? null,
                deferred_at: prior.deferred_at ?? null,
                deferred_reason: prior.deferred_reason ?? null,
                deferred_until: prior.deferred_until ?? null,
              }
            : {}),
        };
      }
      return {
        contract_id: id,
        document_type: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        label,
        is_required: true,
        status: "pending",
      };
    });

    const { data: insertedRows, error } = await supabase
      .from("contract_documents")
      .insert(toInsert)
      .select("*");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    created = (insertedRows || []).length;
  }

  // 2. Update existing pending slots where a prior approved/deferred doc is now available
  let updated = 0;
  for (const label of pendingLabels) {
    const prior = priorByLabel.get(label);
    if (!prior?.document_id) continue;

    const slot = slotByLabel.get(label);
    const updatePayload: Record<string, unknown> = {
      document_id: prior.document_id,
      status: prior.status,
      reviewed_by: prior.reviewed_by ?? null,
      reviewed_at: prior.reviewed_at ?? null,
      notes: prior.notes ? `${prior.notes} [carried forward]` : "Carried forward from prior contract",
    };
    if (prior.status === "deferred") {
      updatePayload.deferred_by = prior.deferred_by ?? null;
      updatePayload.deferred_at = prior.deferred_at ?? null;
      updatePayload.deferred_reason = prior.deferred_reason ?? null;
      updatePayload.deferred_until = prior.deferred_until ?? null;
    }

    const { error } = await supabase
      .from("contract_documents")
      .update(updatePayload)
      .eq("id", slot.id);

    if (!error) updated++;
  }

  // Fetch final state to return
  const { data: final } = await supabase
    .from("contract_documents")
    .select("*")
    .eq("contract_id", id);

  return NextResponse.json({ data: final || [], created, updated });
}
