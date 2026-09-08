import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// GET — returns only non-secret settings needed by the frontend
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const PUBLIC_KEYS = ["razorpay_enabled", "razorpay_key_id", "upi_id", "upi_qr_code_path", "crm_gst_enabled", "tally_sync_enabled", "tally_handoff_v2_enabled", "facility_classifier_ui_enabled", "leegality_enabled"];

  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", PUBLIC_KEYS);

  const result: Record<string, string> = {};
  (settings || []).forEach((s) => {
    result[s.key] = s.value;
  });

  // Fetch UPI QR code image and return as base64 for PDF embedding
  // Uses admin client to bypass storage RLS
  if (result.upi_qr_code_path) {
    try {
      const adminSupabase = await createAdminClient();
      const { data: fileData } = await adminSupabase.storage
        .from("crm-documents")
        .download(result.upi_qr_code_path);
      if (fileData) {
        const arrayBuffer = await fileData.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        const mimeType = result.upi_qr_code_path.endsWith(".png") ? "image/png" : "image/jpeg";
        result.upi_qr_code_base64 = `data:${mimeType};base64,${base64}`;
      }
    } catch {
      // Continue without QR code if download fails
    }
  }

  return NextResponse.json({ data: result });
}
