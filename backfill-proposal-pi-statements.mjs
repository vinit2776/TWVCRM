import { createClient } from "@supabase/supabase-js";

// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) to be present.
process.loadEnvFile(".env.local");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Same GST math as src/lib/tax.ts calcGst() — always intra-state Tamil Nadu (CGST+SGST only).
function calcGst(subtotal, taxRate) {
  const taxAmount = parseFloat((subtotal * taxRate / 100).toFixed(2));
  const half = parseFloat((taxAmount / 2).toFixed(2));
  return { taxAmount, cgst: half, sgst: half, grandTotal: parseFloat((subtotal + taxAmount).toFixed(2)) };
}

// Same proration formula as src/app/api/proposals/[id]/send-invoice/route.ts.
function prorate(occupationStartDate, subtotal, taxPercentage, items) {
  const startDate = new Date(occupationStartDate + "T00:00:00Z");
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();
  const dayOfMonth = startDate.getUTCDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth + 1;
  const prorationFactor = daysRemaining / daysInMonth;

  const proratedSubtotal = Math.round(subtotal * prorationFactor * 100) / 100;
  const { taxAmount, grandTotal: totalAmount } = calcGst(proratedSubtotal, taxPercentage);
  const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${daysInMonth}`;

  const lineItems = (items || []).map((item) => {
    const proratedRate = Math.round(item.unit_price * prorationFactor * 100) / 100;
    return {
      description: item.description,
      qty: item.quantity,
      unit_price: proratedRate,
      amount: Math.round(item.quantity * proratedRate * 100) / 100,
      monthly_rate: item.unit_price,
      days_used: daysRemaining,
      days_in_month: daysInMonth,
      hsn_sac_code: "997221", // resolveHsnCode("rent")
    };
  });

  return { proratedSubtotal, taxAmount, totalAmount, periodEnd, lineItems };
}

async function run() {
  const { data: proposals, error } = await supabase
    .from("proposals")
    .select("id, proposal_number, occupation_start_date, subtotal, total_amount, tax_percentage, items, payment_status, payment_received_at, payment_amount, payment_reference")
    .not("occupation_start_date", "is", null);

  if (error) {
    console.error("Failed to fetch proposals:", error.message);
    process.exit(1);
  }

  console.log(`Found ${proposals.length} proposals with a PI already sent (occupation_start_date set).`);

  // Idempotency: skip proposals that already have a billing_statements row.
  const proposalIds = proposals.map((p) => p.id);
  const { data: existing } = await supabase
    .from("billing_statements")
    .select("proposal_id")
    .in("proposal_id", proposalIds);
  const alreadyBackfilled = new Set((existing || []).map((s) => s.proposal_id));

  const today = new Date().toISOString().slice(0, 10);
  let created = 0, skipped = 0, failed = 0;

  for (const p of proposals) {
    if (alreadyBackfilled.has(p.id)) {
      skipped++;
      console.log(`  [SKIP] ${p.proposal_number} — already has a billing_statements row`);
      continue;
    }

    const subtotal = Number(p.subtotal || p.total_amount || 0);
    const taxPercentage = Number(p.tax_percentage || 18);
    const { proratedSubtotal, taxAmount, totalAmount, periodEnd, lineItems } =
      prorate(p.occupation_start_date, subtotal, taxPercentage, p.items);

    const isPaid = p.payment_status === "paid";

    const row = {
      proposal_id: p.id,
      contract_id: null,
      statement_type: "rent",
      created_via: "proposal_pi",
      status: "finalized",
      period_start: p.occupation_start_date,
      period_end: periodEnd,
      fixed_amount: proratedSubtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      line_items: [{ type: "rent", label: "Proposal Items", items: lineItems, subtotal: proratedSubtotal }],
      ...(isPaid
        ? {
            payment_status: "paid",
            handoff_state: "pi_paid_awaiting_gst",
            due_date: (p.payment_received_at || today).slice(0, 10),
          }
        : {
            payment_status: "unpaid",
            handoff_state: "pi_awaiting_payment",
            due_date: today, // fresh grace period — original due date isn't recoverable
          }),
    };

    const { error: insertErr } = await supabase.from("billing_statements").insert(row);
    if (insertErr) {
      failed++;
      console.error(`  [FAIL] ${p.proposal_number}: ${insertErr.message}`);
      continue;
    }
    created++;
    console.log(`  [OK] ${p.proposal_number} — ₹${totalAmount} (${isPaid ? "paid" : "unpaid"})`);
  }

  console.log(`\nDone. Created: ${created}, Skipped (already backfilled): ${skipped}, Failed: ${failed}`);
}

run().catch(console.error);
