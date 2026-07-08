import { createClient } from "@supabase/supabase-js";

// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) to be present.
process.loadEnvFile(".env.local");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  // Only the "sent" ad-hoc invoices — already emailed, awaiting payment. Draft
  // invoices haven't been sent to anyone, so there's nothing to chase yet.
  const { data: invoices, error } = await supabase
    .from("proforma_invoices")
    .select("id, invoice_number, proposal_id, title, subtotal, tax_percentage, tax_amount, total_amount, due_date, items, razorpay_link_id, razorpay_link_url")
    .eq("status", "sent");

  if (error) {
    console.error("Failed to fetch proforma_invoices:", error.message);
    process.exit(1);
  }

  console.log(`Found ${invoices.length} 'sent' ad-hoc invoices to backfill.`);

  const invoiceIds = invoices.map((i) => i.id);
  const { data: existing } = await supabase
    .from("billing_statements")
    .select("invoice_id")
    .in("invoice_id", invoiceIds);
  const alreadyBackfilled = new Set((existing || []).map((s) => s.invoice_id));

  const todayYmd = new Date().toISOString().slice(0, 10);
  let created = 0, skipped = 0, failed = 0;

  for (const inv of invoices) {
    if (alreadyBackfilled.has(inv.id)) {
      skipped++;
      console.log(`  [SKIP] ${inv.invoice_number} — already has a billing_statements row`);
      continue;
    }

    const lineItems = (inv.items || []).map((item) => ({
      description: item.description,
      qty: item.quantity,
      unit_price: item.unit_price,
      amount: item.total,
      hsn_sac_code: "999799", // resolveHsnCode("ad_hoc_charges") fallback
    }));

    const row = {
      invoice_id: inv.id,
      contract_id: null,
      proposal_id: inv.proposal_id ?? null,
      statement_type: "usage",
      created_via: "adhoc_invoice",
      status: "finalized",
      payment_status: "unpaid",
      handoff_state: "pi_awaiting_payment",
      period_start: todayYmd,
      period_end: todayYmd,
      subtotal: inv.subtotal,
      fixed_amount: inv.subtotal,
      tax_percentage: inv.tax_percentage,
      tax_amount: inv.tax_amount,
      total_amount: inv.total_amount,
      due_date: inv.due_date || todayYmd,
      razorpay_payment_link_id: inv.razorpay_link_id ?? null,
      razorpay_payment_link_url: inv.razorpay_link_url ?? null,
      line_items: [{ type: "usage", label: inv.title, items: lineItems, subtotal: inv.subtotal }],
    };

    const { error: insertErr } = await supabase.from("billing_statements").insert(row);
    if (insertErr) {
      failed++;
      console.error(`  [FAIL] ${inv.invoice_number}: ${insertErr.message}`);
      continue;
    }
    created++;
    console.log(`  [OK] ${inv.invoice_number} — ₹${inv.total_amount}`);
  }

  console.log(`\nDone. Created: ${created}, Skipped (already backfilled): ${skipped}, Failed: ${failed}`);
}

run().catch(console.error);
