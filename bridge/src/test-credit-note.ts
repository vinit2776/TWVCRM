/**
 * Standalone e2e test for the credit-note path — no real Tally needed.
 *
 *   npx ts-node src/test-credit-note.ts
 *
 * Runs TallyClient.postCreditNote against the in-process mock Tally server and
 * asserts the REVERSAL structure: a credit note flips every sign vs the sale —
 * party CREDITED, income + output tax DEBITED — and references the original invoice.
 *
 * Proves the wiring + sign logic. Does NOT replace verifying against a real
 * credit-note export (see the BEST-ESTIMATE note in tally-client.ts).
 */

import fs from "fs";
import "./mock-tally-server";
import { TallyClient } from "./tally-client";
import type { Config } from "./config";

const PARTY   = "Acme Coworking Pvt Ltd";
const INVOICE = "SD/A/26-27/182";
const TAXABLE = 2000;        // 18% → 180 + 180 → total 2360

const config = {
  tally_host: "localhost",
  tally_port: 9000,
  tally_target_company: "Sree Design Infrastructure Pvt Ltd",
} as unknown as Config;

const failures: string[] = [];
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures.push(label);
}

function blockFor(xml: string, ledger: string): string | null {
  const blocks = xml.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g) ?? [];
  for (const b of blocks) if (b.includes(`<LEDGERNAME>${ledger}</LEDGERNAME>`)) return b;
  return null;
}

async function main(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  const tally = new TallyClient(config);

  console.log("\n[1] ping mock Tally");
  check("mock responds to ping", await tally.ping());

  console.log("\n[2] postCreditNote (reverses an invoice)");
  const result = await tally.postCreditNote({
    idempotency_key:  "credit_note:test-stmt-001",
    credit_date:      "2026-06-04",
    voucher_type:     "CREDIT NOTE-REG",
    party_ledger:     PARTY,
    party_gstin:      "33AAAAA0000A1Z5",
    place_of_supply:  "Tamil Nadu",
    stock_item:       "Rent-The WorkVilla",
    income_ledger:    "Rent The Workvilla 18%",
    cgst_ledger:      "CGST Output 9%",
    sgst_ledger:      "SGST Output 9%",
    tax_percentage:   18,
    original_invoice: INVOICE,
    original_invoice_date: "2026-04-10",
    line_items:       [{ description: "Coworking — May", amount: TAXABLE }],
    narration:        "TWV CRM Credit Note | Reverses: " + INVOICE,
  });

  check("returns a credit note identifier", !!result.voucher_number && result.voucher_number.startsWith("CN/"));
  check("returns a voucher guid", !!result.voucher_guid);
  check("total = taxable + 18%", result.total_amount === 2360);

  console.log("\n[3] inspect the reversal XML");
  const xml = fs.readFileSync("/tmp/last-creditnote.xml", "utf-8");

  check("VOUCHERTYPENAME is CREDIT NOTE-REG", /<VOUCHERTYPENAME>\s*CREDIT NOTE-REG\s*<\/VOUCHERTYPENAME>/i.test(xml));
  check("top-level REFERENCE to the original invoice", xml.includes(`<REFERENCE>${INVOICE}</REFERENCE>`));
  check("REFERENCEDATE present (20260410)", xml.includes("<REFERENCEDATE>20260410</REFERENCEDATE>"));
  check("idempotency REMOTEID embedded", xml.includes("credit_note:test-stmt-001"));

  // Party — CREDITED on a credit note (opposite of the sale): ISDEEMEDPOSITIVE=No, positive.
  const partyBlock = blockFor(xml, PARTY);
  check("party entry present", !!partyBlock);
  check("party is CREDITED (ISDEEMEDPOSITIVE=No)", !!partyBlock && /<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/.test(partyBlock));
  check("party amount positive (2360.00)", !!partyBlock && partyBlock.includes("<AMOUNT>2360.00</AMOUNT>"));
  check("Agst Ref to the original invoice", !!partyBlock && partyBlock.includes(`<NAME>${INVOICE}</NAME>`) && /<BILLTYPE>Agst Ref<\/BILLTYPE>/.test(partyBlock));

  // Output tax — DEBITED (reversed): ISDEEMEDPOSITIVE=Yes, negative.
  const cgstBlock = blockFor(xml, "CGST Output 9%");
  check("CGST is reversed/DEBITED (ISDEEMEDPOSITIVE=Yes)", !!cgstBlock && /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/.test(cgstBlock));
  check("CGST amount negative (-180.00)", !!cgstBlock && cgstBlock.includes("<AMOUNT>-180.00</AMOUNT>"));

  // Income — DEBITED (reversed) inside the inventory allocation.
  check("income reversed (negative AMOUNT in allocation)", /<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<AMOUNT>-2000\.00<\/AMOUNT>/.test(xml));

  console.log("");
  if (failures.length) {
    console.error(`FAIL — ${failures.length} assertion(s) failed:`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log("PASS — credit-note reversal matches the real CN/A/26-27/1 format (verified).");
  process.exit(0);
}

main().catch((err) => { console.error("Test threw:", err); process.exit(1); });
