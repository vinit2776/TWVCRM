import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { extractFromPdf } from "@/lib/tally-pdf-extract";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { isInboxRole, type ExtractResponse } from "@/lib/tally-handoff";

/**
 * POST /api/booking-gst-tasks/[id]/extract-gst-invoice
 *
 * Server-side PDF autofill for booking GST tasks. Identical to the
 * billing-statements version — runs PDF text parse + bridge cross-check.
 * Read-only: never persists anything.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: _taskId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser || !isInboxRole(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Could not parse upload" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  // Image files skip PDF extraction — return manual source
  if (file.type !== "application/pdf") {
    const response: ExtractResponse = { source: "manual", fields: {}, raw_text_snippet: null, bridge_match: false, po_number_found: null };
    return NextResponse.json(response);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await extractFromPdf(buffer);

  // Bridge cross-check: if we extracted an invoice number, see if Tally has it
  let bridgeMatch = false;
  if (parsed.fields.invoice_number) {
    const { data: snapshot } = await supabase
      .from("tally_voucher_snapshots")
      .select("voucher_master_id")
      .eq("invoice_number", parsed.fields.invoice_number)
      .limit(1)
      .maybeSingle();
    bridgeMatch = !!snapshot;
  }

  const source = parsed.source === "manual" && bridgeMatch ? "bridge_match" : parsed.source;

  const response: ExtractResponse = {
    source,
    fields: parsed.fields,
    raw_text_snippet: parsed.raw_text_snippet,
    bridge_match: bridgeMatch,
    po_number_found: null,
  };

  return NextResponse.json(response);
}
