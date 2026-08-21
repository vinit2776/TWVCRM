import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/billing-statements/[id]/supporting-documents
 *
 * Lists the reimbursement supporting documents (receipts, vendor bills)
 * attached to a billing statement, each with a signed URL for viewing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("reimbursement_supporting_documents")
    .select("id, file_path, file_name, file_mime_type, created_at")
    .eq("billing_statement_id", id)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const adminSupabase = await createAdminClient();
  const withUrls = await Promise.all(
    (data ?? []).map(async (doc) => {
      const { data: signed } = await adminSupabase.storage
        .from("crm-documents")
        .createSignedUrl(doc.file_path, 3600);
      return { ...doc, signed_url: signed?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ data: withUrls });
}
