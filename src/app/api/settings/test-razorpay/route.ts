import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST — test Razorpay connection with stored credentials
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Fetch credentials
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_key_id", "razorpay_key_secret"]);

  const creds: Record<string, string> = {};
  (settings || []).forEach((s) => { creds[s.key] = s.value; });

  const keyId = creds.razorpay_key_id;
  const keySecret = creds.razorpay_key_secret;

  if (!keyId || !keySecret) {
    return NextResponse.json({ error: "Razorpay credentials not configured" }, { status: 400 });
  }

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (res.ok) {
      return NextResponse.json({ success: true, message: "Razorpay connection successful" });
    } else {
      const err = await res.json().catch(() => null);
      return NextResponse.json({
        success: false,
        message: err?.error?.description || `HTTP ${res.status}`,
      }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({
      success: false,
      message: e instanceof Error ? e.message : "Connection failed",
    }, { status: 500 });
  }
}
