import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getCachedSetting } from "@/lib/app-settings-cache";
import { PC_RECEIPT_NUDGE_DEFAULT } from "@/lib/petty-cash-attachments";

/** GET /api/petty-cash/receipt-policy — the amount from which a missing bill is flagged. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const raw = await getCachedSetting(createAdminClient(), "petty_cash_receipt_nudge_amount");
  const n = Number(raw);
  return NextResponse.json({ nudgeAmount: Number.isFinite(n) && n > 0 ? n : PC_RECEIPT_NUDGE_DEFAULT });
}
