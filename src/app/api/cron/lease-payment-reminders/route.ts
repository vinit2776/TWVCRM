import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/mailer";

// Runs daily at 09:00 IST (03:30 UTC)
// Finds payments due in next 7 days and sends reminder to accounts team
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const today = new Date().toISOString().split("T")[0];
  const in7Days = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

  // Find pending payments due within 7 days that haven't been notified today
  const { data: payments, error } = await admin
    .from("lease_payments")
    .select(`
      id, payment_month, due_date, gross_rent_amount, tds_amount,
      lease:property_leases(
        id,
        location:locations(name),
        landlord:landlords(name, email)
      )
    `)
    .eq("status", "pending")
    .gte("due_date", today)
    .lte("due_date", in7Days)
    .or(`notified_at.is.null,notified_at.lt.${today}`);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!payments || payments.length === 0) {
    return NextResponse.json({ notified: 0 });
  }

  // Get accounts team emails
  const { data: accountsUsers } = await admin
    .from("users")
    .select("email, full_name")
    .in("role", ["admin", "accounts"]);

  const toEmails = (accountsUsers || []).map((u) => u.email).filter(Boolean);

  if (toEmails.length === 0) {
    return NextResponse.json({ notified: 0, reason: "no accounts users" });
  }

  const rows = payments.map((p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lease = p.lease as any;
    const net = p.gross_rent_amount - (p.tds_amount ?? 0);
    return `<tr>
      <td style="padding:8px;border:1px solid #e2e8f0">${lease?.location?.name ?? "—"}</td>
      <td style="padding:8px;border:1px solid #e2e8f0">${lease?.landlord?.name ?? "—"}</td>
      <td style="padding:8px;border:1px solid #e2e8f0">${p.payment_month}</td>
      <td style="padding:8px;border:1px solid #e2e8f0">₹${net.toLocaleString("en-IN")}</td>
      <td style="padding:8px;border:1px solid #e2e8f0">${p.due_date}</td>
    </tr>`;
  }).join("");

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: toEmails,
      subject: `Rent Payments Due — ${payments.length} payment(s) in next 7 days`,
      html: `
        <h2 style="font-family:sans-serif">Upcoming Rent Payments</h2>
        <p style="font-family:sans-serif">${payments.length} payment(s) are due within the next 7 days:</p>
        <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Location</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Landlord</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Month</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Net Payable</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Due Date</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-family:sans-serif;margin-top:16px">
          <a href="${process.env.NEXT_PUBLIC_APP_URL}/rent-management">View in CRM →</a>
        </p>
      `,
    });
  } catch (emailErr) {
    console.error("lease-payment-reminders: email failed:", emailErr);
  }

  // Mark notified_at on all these payments
  const ids = payments.map((p) => p.id);
  await admin
    .from("lease_payments")
    .update({ notified_at: new Date().toISOString() })
    .in("id", ids);

  return NextResponse.json({ notified: payments.length });
}
