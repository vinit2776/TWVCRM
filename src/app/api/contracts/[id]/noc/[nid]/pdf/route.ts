import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { letterFor, loadNocSettings } from "@/lib/noc/server";
import { buildNocPdf } from "@/lib/noc/pdf";
import { nocReference, PURPOSE_LABELS, dotDate, type NocPurpose } from "@/lib/noc/rules";

/**
 * GET /api/contracts/[id]/noc/[nid]/pdf
 * The DRAFT certificate, for staff. In this part every response is a draft: the clean, sealed certificate does not
 * exist yet and is only ever made by the issue step after full payment. Read-only; stores and sends nothing.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;

  const admin = createAdminClient();
  const settings = await loadNocSettings(admin);
  if (!settings.enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });

  const { data: noc } = await admin.from("noc_requests").select("*").eq("id", nid).eq("contract_id", id).single();
  if (!noc) return NextResponse.json({ error: "NOC not found" }, { status: 404 });
  const { data: contract } = await admin
    .from("contracts")
    .select("contract_number, agreement_date, created_at, end_date, tenure_months")
    .eq("id", id).single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const letter = letterFor(noc, contract, settings);
  const reference = nocReference(contract.contract_number, noc.sequence_in_contract);
  const purpose = PURPOSE_LABELS[noc.purpose as NocPurpose];
  const pdf = buildNocPdf({
    letter, reference, nocNumber: noc.noc_number, companyName: noc.company_name, draft: true,
    boldTerms: [
      purpose, noc.company_name, noc.noc_address, dotDate((contract.agreement_date ?? contract.created_at ?? "").toString().slice(0, 10)), dotDate(contract.end_date),
    ],
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${reference.replace("/", "-")}-DRAFT.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
