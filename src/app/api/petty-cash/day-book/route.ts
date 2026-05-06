import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/petty-cash/day-book
 * Generates and emails the daily petty cash summary.
 * Called by Vercel cron at 6:30 PM IST daily.
 * Also supports ?date=YYYY-MM-DD for on-demand generation.
 */
export async function GET(request: Request) {
  // Verify cron secret for automated runs (optional header check)
  const { searchParams } = new URL(request.url);
  const targetDate = searchParams.get("date") || new Date().toISOString().slice(0, 10);

  const supabase = await createAdminClient();

  // 1. Get today's approved entries
  const { data: entries } = await supabase
    .from("petty_cash_entries")
    .select(
      `*, category:petty_cash_categories!petty_cash_entries_category_id_fkey(name), book:petty_cash_books!petty_cash_entries_book_id_fkey(user_id, owner:users!petty_cash_books_user_id_fkey(full_name))`
    )
    .eq("status", "approved")
    .eq("date", targetDate)
    .order("created_at");

  // 2. Get today's issued requests
  const { data: issuances } = await supabase
    .from("petty_cash_requests")
    .select(
      `*, book:petty_cash_books!petty_cash_requests_book_id_fkey(user_id, owner:users!petty_cash_books_user_id_fkey(full_name)), issuer:users!petty_cash_requests_issued_by_fkey(full_name)`
    )
    .eq("status", "issued")
    .gte("issued_at", `${targetDate}T00:00:00`)
    .lte("issued_at", `${targetDate}T23:59:59`);

  const approvedEntries = entries || [];
  const issuedRequests = issuances || [];

  if (approvedEntries.length === 0 && issuedRequests.length === 0) {
    return NextResponse.json({ message: "No transactions today, skipping email." });
  }

  // 3. Compute category breakdown
  const categoryTotals: Record<string, number> = {};
  let totalSpend = 0;
  for (const e of approvedEntries) {
    const catName = (e.category as { name: string } | null)?.name || "Uncategorized";
    categoryTotals[catName] = (categoryTotals[catName] || 0) + Number(e.amount);
    totalSpend += Number(e.amount);
  }

  let totalIssued = 0;
  for (const r of issuedRequests) {
    totalIssued += Number(r.amount_requested);
  }

  // 4. Build HTML email
  const categoryRows = Object.entries(categoryTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, total]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${cat}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">₹${total.toLocaleString("en-IN")}</td></tr>`)
    .join("");

  const entryRows = approvedEntries
    .map((e) => {
      const owner = (e.book as { owner: { full_name: string } })?.owner?.full_name || "—";
      const cat = (e.category as { name: string } | null)?.name || "—";
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${owner}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${cat}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${e.description}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:13px">₹${Number(e.amount).toLocaleString("en-IN")}</td>
      </tr>`;
    })
    .join("");

  const issuanceRows = issuedRequests
    .map((r) => {
      const owner = (r.book as { owner: { full_name: string } })?.owner?.full_name || "—";
      const issuer = (r.issuer as { full_name: string })?.full_name || "—";
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${owner}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">₹${Number(r.amount_requested).toLocaleString("en-IN")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${r.issuance_method || "—"}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${issuer}</td>
      </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <h2 style="color:#1a1a1a;border-bottom:2px solid #f59e0b;padding-bottom:8px">
        Petty Cash Day Book — ${new Date(targetDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" })}
      </h2>

      <div style="display:flex;gap:20px;margin:16px 0">
        <div style="background:#fef3c7;padding:12px 20px;border-radius:8px;flex:1">
          <div style="font-size:12px;color:#92400e">Total Spend</div>
          <div style="font-size:22px;font-weight:bold;color:#92400e">₹${totalSpend.toLocaleString("en-IN")}</div>
        </div>
        <div style="background:#d1fae5;padding:12px 20px;border-radius:8px;flex:1">
          <div style="font-size:12px;color:#065f46">Total Issued</div>
          <div style="font-size:22px;font-weight:bold;color:#065f46">₹${totalIssued.toLocaleString("en-IN")}</div>
        </div>
      </div>

      ${Object.keys(categoryTotals).length > 0 ? `
      <h3 style="color:#374151;margin-top:24px">Spend by Category</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-size:13px;color:#6b7280">Category</th>
          <th style="padding:8px 12px;text-align:right;font-size:13px;color:#6b7280">Amount</th>
        </tr></thead>
        <tbody>${categoryRows}
          <tr style="font-weight:bold;background:#f9fafb">
            <td style="padding:8px 12px">Total</td>
            <td style="padding:8px 12px;text-align:right">₹${totalSpend.toLocaleString("en-IN")}</td>
          </tr>
        </tbody>
      </table>` : ""}

      ${approvedEntries.length > 0 ? `
      <h3 style="color:#374151">Approved Expenses (${approvedEntries.length})</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Person</th>
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Category</th>
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Description</th>
          <th style="padding:6px 8px;text-align:right;font-size:12px;color:#6b7280">Amount</th>
        </tr></thead>
        <tbody>${entryRows}</tbody>
      </table>` : ""}

      ${issuedRequests.length > 0 ? `
      <h3 style="color:#374151">Cash Issued (${issuedRequests.length})</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Person</th>
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Amount</th>
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Method</th>
          <th style="padding:6px 8px;text-align:left;font-size:12px;color:#6b7280">Issued By</th>
        </tr></thead>
        <tbody>${issuanceRows}</tbody>
      </table>` : ""}

      <p style="color:#9ca3af;font-size:12px;margin-top:24px">
        This is an automated email from TWV CRM Petty Cash module.
      </p>
    </div>
  `;

  // 5. Get admin + accounts email addresses
  const { data: recipients } = await supabase
    .from("users")
    .select("email")
    .in("role", ["admin", "accounts"])
    .eq("is_active", true);

  const emails = (recipients || []).map((r) => r.email).filter(Boolean);
  if (emails.length === 0) {
    return NextResponse.json({ message: "No recipients found" });
  }

  // 6. Send email
  const { error: emailErr } = await resend.emails.send({
    from: EMAIL_FROM,
    to: emails,
    subject: `Petty Cash Day Book — ${targetDate}`,
    html,
    replyTo: EMAIL_REPLY_TO,
  });

  if (emailErr) {
    return NextResponse.json({ error: emailErr.message }, { status: 500 });
  }

  await pingCronHealth("petty-cash/day-book", "ok", { sent_to: emails.length, date: targetDate });
  return NextResponse.json({ success: true, sent_to: emails.length, date: targetDate });
}
