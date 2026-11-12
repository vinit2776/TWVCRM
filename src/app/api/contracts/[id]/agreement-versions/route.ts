import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getAgreementDocumentHistory } from "@/lib/agreement-document-history";

/**
 * GET /api/contracts/[id]/agreement-versions
 *
 * Full version history of the signed agreement, newest first, walked via
 * documents.parent_document_id. See reupload-agreement/route.ts.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, signed_document_id")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const adminSupabase = await createAdminClient();
  const data = await getAgreementDocumentHistory(adminSupabase, contract.signed_document_id);

  return NextResponse.json({ data });
}
