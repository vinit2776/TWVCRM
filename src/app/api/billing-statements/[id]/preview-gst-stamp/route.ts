import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { stampSignatureOnPdf } from "@/lib/uploads/stamp-pdf-signature";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/preview-gst-stamp
 *
 * Preview-only endpoint: accepts a PDF via multipart form, stamps it with the
 * company signature + seal, and returns the stamped bytes. No DB writes, no
 * storage uploads — purely for the pre-submit preview in the Tally inbox form.
 *
 * Auth: accounts or admin only (same guard as the upload endpoint).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await params; // unused but required to satisfy Next.js route typing

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!dbUser || !["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Could not parse upload" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF files can be previewed" }, { status: 400 });
  }
  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 50 MB)" }, { status: 400 });
  }

  const raw = Buffer.from(await file.arrayBuffer());
  const stamped = await stampSignatureOnPdf(raw);

  return new NextResponse(stamped.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="preview-stamped.pdf"',
      "Content-Length": String(stamped.length),
    },
  });
}
