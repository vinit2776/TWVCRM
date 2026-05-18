import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/mailer";

// Runs 28th of month at 10:00 IST (04:30 UTC)
// Finds leases with next_escalation_date within 30 days,
// auto-creates a 'scheduled' escalation row if none exists, notifies admin.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const today = new Date().toISOString().split("T")[0];
  const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

  const { data: leases, error } = await admin
    .from("property_leases")
    .select(`
      id, base_rent_amount, escalation_type, escalation_value,
      escalation_frequency_months, next_escalation_date,
      location:locations(name),
      landlord:landlords(name)
    `)
    .eq("status", "active")
    .not("escalation_type", "eq", "none")
    .gte("next_escalation_date", today)
    .lte("next_escalation_date", in30Days);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!leases || leases.length === 0) {
    return NextResponse.json({ created: 0 });
  }

  let created = 0;

  for (const lease of leases) {
    // Skip if a scheduled escalation already exists for this date
    const { data: existing } = await admin
      .from("lease_escalations")
      .select("id")
      .eq("lease_id", lease.id)
      .eq("scheduled_date", lease.next_escalation_date!)
      .eq("status", "scheduled")
      .maybeSingle();

    if (existing) continue;

    // Calculate new rent amount for percentage/flat escalations
    let newRentAmount: number | null = null;
    if (lease.escalation_type === "percentage" && lease.escalation_value) {
      newRentAmount = Math.round(lease.base_rent_amount * (1 + lease.escalation_value / 100));
    } else if (lease.escalation_type === "flat" && lease.escalation_value) {
      newRentAmount = lease.base_rent_amount + lease.escalation_value;
    }

    const { error: insertErr } = await admin
      .from("lease_escalations")
      .insert({
        lease_id: lease.id,
        scheduled_date: lease.next_escalation_date,
        escalation_type: lease.escalation_type,
        escalation_value: lease.escalation_value,
        new_rent_amount: newRentAmount,
        status: "scheduled",
        notes: "Auto-created by escalation check cron",
      });

    if (!insertErr) created++;
  }

  // Notify admin
  if (created > 0) {
    const { data: admins } = await admin
      .from("users")
      .select("email")
      .eq("role", "admin");

    const toEmails = (admins || []).map((u) => u.email).filter(Boolean);

    if (toEmails.length > 0) {
      const rows = leases.map((l) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loc = (l as any).location?.name ?? "—";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ll = (l as any).landlord?.name ?? "—";
        return `<tr>
          <td style="padding:8px;border:1px solid #e2e8f0">${loc}</td>
          <td style="padding:8px;border:1px solid #e2e8f0">${ll}</td>
          <td style="padding:8px;border:1px solid #e2e8f0">${l.next_escalation_date}</td>
          <td style="padding:8px;border:1px solid #e2e8f0">₹${l.base_rent_amount.toLocaleString("en-IN")}</td>
        </tr>`;
      }).join("");

      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: toEmails,
          subject: `Rent Escalations Upcoming — ${leases.length} lease(s) need attention`,
          html: `
            <h2 style="font-family:sans-serif">Rent Escalation Alert</h2>
            <p style="font-family:sans-serif">${leases.length} lease(s) have escalations scheduled in the next 30 days:</p>
            <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px">
              <thead>
                <tr style="background:#f8fafc">
                  <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Location</th>
                  <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Landlord</th>
                  <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Date</th>
                  <th style="padding:8px;border:1px solid #e2e8f0;text-align:left">Current Rent</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <p style="font-family:sans-serif;margin-top:16px">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/rent-management">Review in CRM →</a>
            </p>
          `,
        });
      } catch (emailErr) {
        console.error("lease-escalation-check: email failed:", emailErr);
      }
    }
  }

  return NextResponse.json({ created, total: leases.length });
}
