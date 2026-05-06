import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dltSms } from "@/lib/whatsapp";

/**
 * POST /api/contracts/renewal-reminders
 *
 * Sends DLT SMS (TWV_Contract_Renewal) to clients whose contracts are
 * ending within a configurable number of days (default 30).
 *
 * Body (optional): { days_ahead?: number }
 *
 * Can be called manually from admin UI or via a scheduled cron job.
 * Only sends to contracts that are currently "active" and have a lead
 * with a phone number on file.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only admin/manager can trigger renewal reminders
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let daysAhead = 30;
  try {
    const body = await request.json();
    if (body.days_ahead && Number(body.days_ahead) > 0) {
      daysAhead = Number(body.days_ahead);
    }
  } catch {
    // No body or invalid JSON — use default 30 days
  }

  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + daysAhead);

  const todayStr = today.toISOString().split("T")[0];
  const cutoffStr = cutoff.toISOString().split("T")[0];

  // Fetch active contracts ending within the window
  const { data: contracts, error } = await supabase
    .from("contracts")
    .select(
      "id, contract_number, end_date, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, phone, mobile)"
    )
    .eq("status", "active")
    .gte("end_date", todayStr)
    .lte("end_date", cutoffStr);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  const results: { contract: string; phone: string; status: string }[] = [];

  for (const contract of contracts || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = contract.lead as any;
    const phone = lead?.phone || lead?.mobile;
    if (!phone) {
      skipped++;
      continue;
    }

    const customerName = lead?.first_name || "Client";
    const renewalDate = new Date(contract.end_date as string).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    try {
      const smsResult = await dltSms.contractRenewal(phone, customerName, renewalDate, contract.id as string);
      results.push({
        contract: contract.contract_number as string,
        phone,
        status: smsResult.success ? "sent" : `failed: ${smsResult.error}`,
      });
      if (smsResult.success) sent++;
    } catch (err) {
      results.push({
        contract: contract.contract_number as string,
        phone,
        status: `error: ${String(err)}`,
      });
    }
  }

  return NextResponse.json({
    message: `Renewal reminders processed`,
    days_ahead: daysAhead,
    total: (contracts || []).length,
    sent,
    skipped,
    results,
  });
}
