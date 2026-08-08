import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildAddendumPdfBuffer } from "@/lib/addendum-generator";

/**
 * GET /api/contracts/[id]/addendum
 *
 * Generates and returns an addendum PDF for a renewal contract.
 * The contract must be a renewal (is_renewal = true).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, is_renewal, parent_contract_id")
    .eq("id", id)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.is_renewal || !contract.parent_contract_id) {
    return NextResponse.json({ error: "Addendum can only be generated for renewal contracts" }, { status: 400 });
  }

  const pdfBuffer = await buildAddendumPdfBuffer(supabase, id);
  if (!pdfBuffer) {
    return NextResponse.json({ error: "Failed to generate addendum PDF" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Addendum-${contract.contract_number}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
