import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getAgreementDocumentHistory } from "@/lib/agreement-document-history";

/**
 * GET /api/cases/[id]/leave-license/agreement-versions
 *
 * Full version history of the L&L agreement's executed document, newest
 * first. See reupload-agreement/route.ts for which field ("document of
 * record") is followed.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, signed_document_id, generated_document_id")
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!agreement) {
    return NextResponse.json({ error: "No leave & license agreement found" }, { status: 404 });
  }

  const currentDocId = agreement.signed_document_id ?? agreement.generated_document_id;

  const adminSupabase = await createAdminClient();
  const data = await getAgreementDocumentHistory(adminSupabase, currentDocId);

  return NextResponse.json({ data, agreement_id: agreement.id });
}
