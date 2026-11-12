/**
 * Audit line item arithmetic across every document source that can print a rate.
 *
 *   node scripts/audit-line-item-arithmetic.mjs
 *
 * Read-only. Generates no proforma, sends no email, touches no customer.
 *
 * WHY THIS EXISTS
 * ---------------
 * CLAUDE.md's billing/PDF smoke test asks a human to open a proforma and check
 * that Qty x Rate = Amount on every line, and that Qty is not 1 when usage is
 * more than one unit. Doing that by hand covers one document and requires
 * generating a real proforma against live customer data.
 *
 * The same assertions can be made against the data the PDFs render from, for
 * every document at once, with no side effects. That is what this does.
 *
 * WHERE A RATE IS ACTUALLY PRINTED
 * --------------------------------
 * Worth knowing before reading the output, because it is not obvious and got
 * mis-diagnosed once already (see issue #498):
 *
 *   billing_statements  -> proforma shows description + amount ONLY. The GST
 *                          tax invoice does show Qty and Rate, but in whole
 *                          rupees with an explicit Round Off line in the totals.
 *   proposals           -> Qty and Unit Price at 2 dp (generatePDF)
 *   proforma_invoices   -> Qty and Unit Price at 2 dp (generatePDF)
 *   contracts           -> the contract download is the membership agreement,
 *                          which prints No. / Description / Details and no rate.
 *                          generateContractPDF would print one, but is unused.
 *
 * So a finding here is a data-integrity signal. Whether it is customer-visible
 * depends on the document, per the table above.
 *
 * Exits non-zero if a qty is missing (the trap the manual test targets), so this
 * can gate CI later if wanted. Rate mismatches are reported but do not fail the
 * run, since several are display-only or unreachable.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = {};
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n$/, "");
    env[m[1]] = v;
  }
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/** Tolerance: half a paisa. Below this the difference disappears when rounded. */
const EPS = 0.005;

/** Mirrors resolveLineItemQty / resolveLineItemRate in src/lib/billing-pdf-utils.ts. */
const qtyOf = (it) => Number(it.qty ?? it.quantity ?? it.billable ?? it.overage ?? 1);
const qtyMissing = (it) => (it.qty ?? it.quantity ?? it.billable ?? it.overage) == null;
const rateOf = (it) => Number(it.unit_price || it.rate || it.amount || 0);

const results = [];

/** billing_statements keeps its lines in sectioned JSONB. */
async function auditStatements() {
  const { data, error } = await supabase
    .from("billing_statements")
    .select("statement_number, line_items")
    .not("line_items", "is", null)
    .is("voided_at", null);
  if (error) return { source: "billing_statements", error: error.message };

  const out = { source: "billing_statements", records: 0, items: 0, rateMismatch: [], missingQty: [], qtyOneSuspect: [] };
  for (const s of data ?? []) {
    const sections = Array.isArray(s.line_items) ? s.line_items : [];
    if (!sections.length) continue;
    out.records++;
    for (const section of sections) {
      for (const it of section.items ?? []) {
        out.items++;
        const qty = qtyOf(it), rate = rateOf(it), amount = Number(it.amount || 0);
        const printed = Number(rate.toFixed(2));
        if (qty > 0 && Math.abs(printed * qty - amount) > EPS) {
          out.rateMismatch.push({ doc: s.statement_number, qty, printed, amount,
            shows: `${qty} x ${printed} = ${(printed * qty).toFixed(2)}` });
        }
        if (qtyMissing(it)) out.missingQty.push({ doc: s.statement_number, section: section.type, amount });
        if (qty === 1 && rate > 0 && Math.abs(amount - rate) > EPS) {
          out.qtyOneSuspect.push({ doc: s.statement_number, rate, amount,
            impliedUnits: Number((amount / rate).toFixed(2)) });
        }
      }
    }
  }
  return out;
}

/** proposals / proforma_invoices / contracts keep a flat items array. */
async function auditFlat(table, numberCol) {
  const { data, error } = await supabase.from(table).select(`${numberCol}, items`).not("items", "is", null);
  if (error) return { source: table, error: error.message };

  const out = { source: table, records: 0, items: 0, rateMismatch: [], missingQty: [], qtyOneSuspect: [] };
  for (const r of data ?? []) {
    const list = Array.isArray(r.items) ? r.items : [];
    if (!list.length) continue;
    out.records++;
    for (const it of list) {
      out.items++;
      const qty = Number(it.quantity ?? 1);
      const rate = Number(it.unit_price ?? 0);
      const total = Number(it.total ?? 0);
      const printed = Number(rate.toFixed(2));
      if (qty > 0 && Math.abs(printed * qty - total) > EPS) {
        out.rateMismatch.push({ doc: r[numberCol], qty, printed, amount: total,
          shows: `${qty} x ${printed} = ${(printed * qty).toFixed(2)}` });
      }
      if (it.quantity == null) out.missingQty.push({ doc: r[numberCol], amount: total });
    }
  }
  return out;
}

results.push(await auditStatements());
results.push(await auditFlat("proposals", "proposal_number"));
results.push(await auditFlat("proforma_invoices", "invoice_number"));
results.push(await auditFlat("contracts", "contract_number"));

let missingQtyTotal = 0;

for (const r of results) {
  console.log(`\n=== ${r.source} ===`);
  if (r.error) { console.log(`  QUERY FAILED — ${r.error}`); continue; }
  console.log(`  records: ${r.records}   line items: ${r.items}`);

  missingQtyTotal += r.missingQty.length;

  console.log(`  Qty x Rate = Amount   ${r.rateMismatch.length === 0 ? "OK" : `${r.rateMismatch.length} mismatched`}`);
  if (r.rateMismatch.length) console.table(r.rateMismatch.slice(0, 15));

  console.log(`  qty field present     ${r.missingQty.length === 0 ? "OK" : `${r.missingQty.length} MISSING — would print as 1`}`);
  if (r.missingQty.length) console.table(r.missingQty.slice(0, 15));

  if (r.qtyOneSuspect?.length) {
    console.log(`  qty of 1 vs amount    ${r.qtyOneSuspect.length} to review`);
    console.table(r.qtyOneSuspect.slice(0, 15));
  }
}

console.log("\n──────────────────────────────────────────");
if (missingQtyTotal > 0) {
  console.log(`FAIL — ${missingQtyTotal} line item(s) have no qty and would print as 1.`);
  process.exit(1);
}
console.log("PASS — every line item carries a qty; nothing would silently print as 1.");
console.log("Any rate mismatch listed above is display-level; check the table in this");
console.log("file's header for whether that document actually prints a rate column.");
