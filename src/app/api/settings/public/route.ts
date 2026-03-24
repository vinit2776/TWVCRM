import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — returns only non-secret settings needed by the frontend
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const PUBLIC_KEYS = ["razorpay_enabled", "razorpay_key_id", "upi_id", "upi_qr_code_path"];

  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", PUBLIC_KEYS);

  const result: Record<string, string> = {};
  (settings || []).forEach((s) => {
    result[s.key] = s.value;
  });

  // Generate signed URL for UPI QR code image if path exists
  if (result.upi_qr_code_path) {
    const { data: signedData } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(result.upi_qr_code_path, 3600);
    if (signedData?.signedUrl) {
      result.upi_qr_code_url = signedData.signedUrl;
    }
  }

  return NextResponse.json({ data: result });
}
