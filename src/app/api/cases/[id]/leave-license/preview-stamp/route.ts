import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateLeaveLicensePdf, type LeaveLicenseVariables } from "@/lib/leave-license-generator";
import { generateStampReference } from "@/lib/company-stamp";

const PRE_EXECUTED_STATUSES = [
  "draft",
  "internally_approved",
  "sent_to_client",
  "client_approved",
  "signing",
];

/**
 * POST /api/cases/[id]/leave-license/preview-stamp
 *
 * Admin-only, read-only: renders the same stamped PDF the commit endpoint
 * would produce, without writing to storage or the database, so an admin
 * can review placement before the irreversible stamp-sign-seal action runs.
 * Returns the same stampRef the client must echo back on commit so the
 * saved document is byte-for-byte what was previewed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can preview the sign & seal stamp" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const agreementId = body?.agreement_id as string | undefined;
  if (!agreementId) {
    return NextResponse.json({ error: "agreement_id is required" }, { status: 400 });
  }

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, status, signed_document_id, variables")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  if (agreement.signed_document_id) {
    return NextResponse.json(
      { error: "This agreement already has a signed document." },
      { status: 400 }
    );
  }

  if (!PRE_EXECUTED_STATUSES.includes(agreement.status)) {
    return NextResponse.json(
      { error: `Cannot stamp an agreement in '${agreement.status}' status` },
      { status: 400 }
    );
  }

  const stampRef = generateStampReference();
  const pdfDoc = generateLeaveLicensePdf(
    agreement.variables as unknown as LeaveLicenseVariables,
    { applyCompanyStamp: true, stampRef }
  );
  const pdfBase64 = Buffer.from(pdfDoc.output("arraybuffer")).toString("base64");

  return NextResponse.json({ pdfBase64, stampRef });
}
