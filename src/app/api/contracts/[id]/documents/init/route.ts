import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { KYC_DOCUMENTS } from "@/lib/constants";

type Params = { params: Promise<{ id: string }> };

// POST — initialize KYC document slots based on lead's entity type
export async function POST(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch contract with lead's entity_type
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

  // Check if slots already exist
  const { data: existing } = await supabase
    .from("contract_documents")
    .select("label")
    .eq("contract_id", id);

  const existingLabels = new Set((existing || []).map((d) => d.label));

  // Create missing slots
  const toInsert = requiredDocs
    .filter((label: string) => !existingLabels.has(label))
    .map((label: string) => ({
      contract_id: id,
      document_type: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      label,
      is_required: true,
      status: "pending",
    }));

  if (toInsert.length === 0) {
    return NextResponse.json({ data: existing, message: "All slots already exist" });
  }

  const { data: created, error } = await supabase
    .from("contract_documents")
    .insert(toInsert)
    .select("*");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: [...(existing || []), ...(created || [])], created: (created || []).length });
}
