import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor, reference } from "@/lib/addendum/server";
import { buildAddendumPdf } from "@/lib/addendum/pdf";
import { COMPANY_NAME } from "@/lib/pdf-utils";
import { signatureBlocks, type ChangeOfNameParams } from "@/lib/addendum/change-of-name";

/**
 * GET /api/contracts/[id]/addenda/[aid]/pdf
 * Renders the current wording. A DRAFT watermark is printed until the addendum is approved.
 * Read-only: it stores nothing and sends nothing.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;

  const admin = createAdminClient();
  const { data: a } = await admin.from("contract_addenda").select("*").eq("id", aid).eq("contract_id", id).single();
  if (!a) return NextResponse.json({ error: "Addendum not found" }, { status: 404 });
  const { data: contract } = await admin.from("contracts").select("contract_number").eq("id", id).single();
  const p = a.params as ChangeOfNameParams;
  const ref = reference(contract?.contract_number ?? "", a.addendum_number);

  const pdf = buildAddendumPdf({
    reference: ref,
    contractNumber: contract?.contract_number ?? "",
    text: a.current_text,
    signatories: signatureBlocks(p),
    boldTerms: [p.newName, p.outgoingName, p.signatoryName, p.outgoingSignatoryName ?? "", COMPANY_NAME],
    draft: ["draft", "pending_approval", "changes_requested"].includes(a.status),
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${ref.replace("/", "-")}.pdf"`,
    },
  });
}
