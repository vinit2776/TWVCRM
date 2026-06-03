/**
 * Standalone e2e test for the receipt-voucher path — no real Tally needed.
 *
 *   npx ts-node src/test-receipt-voucher.ts
 *
 * Starts the in-process mock Tally server, runs TallyClient.postReceiptVoucher
 * against it, and asserts BOTH:
 *   1. the read-back result (receipt number, guid, amount), and
 *   2. the actual XML the bridge sent (captured by the mock at /tmp/last-receipt.xml):
 *      - parent VOUCHERTYPENAME = Receipt
 *      - bank/cash ledger is DEBITED (ISDEEMEDPOSITIVE=Yes, negative amount)
 *      - party ledger is CREDITED (ISDEEMEDPOSITIVE=No, positive amount)
 *      - bill allocation Agst Ref references the invoice number
 *
 * This proves the CRM↔bridge wiring + XML shape. It does NOT prove the XML is
 * what THIS Tally company accepts — that still needs a real receipt sample
 * (see the BEST-ESTIMATE note in tally-client.ts).
 */

import fs from "fs";
import "./mock-tally-server";          // auto-listens on :9000
import { TallyClient } from "./tally-client";
import type { Config } from "./config";

const PARTY   = "Acme Coworking Pvt Ltd";
const BANK    = "HDFC Bank";
const INVOICE = "SD/A/26-27/182";
const AMOUNT  = 2360;

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

async function main(): Promise<void> {
  // Give the mock a moment to bind the port.
  await new Promise((r) => setTimeout(r, 400));

  const tally = new TallyClient(config);

  console.log("\n[1] ping mock Tally");
  check("mock responds to ping", await tally.ping());

  console.log("\n[2] postReceiptVoucher");
  const result = await tally.postReceiptVoucher({
    idempotency_key: "receipt_voucher:test-payment-001",
    receipt_date:    "2026-06-04",
    voucher_type:    "Receipt",
    party_ledger:    PARTY,
    receipt_ledger:  BANK,
    invoice_number:  INVOICE,
    amount:          AMOUNT,
    narration:       "TWV CRM Receipt | Inv: " + INVOICE,
  });

  check("returns a receipt voucher number", !!result.voucher_number && result.voucher_number.startsWith("RCT/"));
  check("returns a voucher guid", !!result.voucher_guid);
  check("echoes the amount", result.total_amount === AMOUNT);

  console.log("\n[3] inspect the XML the bridge sent");
  const xml = fs.readFileSync("/tmp/last-receipt.xml", "utf-8");
  const amt = AMOUNT.toFixed(2);

  check("parent VOUCHERTYPENAME is Receipt", /<VOUCHERTYPENAME>\s*Receipt\s*<\/VOUCHERTYPENAME>/i.test(xml));
  check("party set as PARTYLEDGERNAME", xml.includes(`<PARTYLEDGERNAME>${PARTY}</PARTYLEDGERNAME>`));
  check("idempotency REMOTEID embedded", xml.includes("receipt_voucher:test-payment-001"));

  // Bank ledger block — debited (money in): ISDEEMEDPOSITIVE=Yes + negative amount.
  const bankBlock = blockFor(xml, BANK);
  check("bank ledger present", !!bankBlock);
  check("bank ledger is a debit (ISDEEMEDPOSITIVE=Yes)", !!bankBlock && /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/.test(bankBlock));
  check("bank ledger amount is negative", !!bankBlock && bankBlock.includes(`<AMOUNT>-${amt}</AMOUNT>`));

  // Party ledger block — credited (settles receivable): ISDEEMEDPOSITIVE=No + positive amount + bill allocation.
  const partyBlock = blockFor(xml, PARTY, /* skipFirst because PARTYLEDGERNAME mentions it */ true);
  check("party ledger entry present", !!partyBlock);
  check("party ledger is a credit (ISDEEMEDPOSITIVE=No)", !!partyBlock && /<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/.test(partyBlock));
  check("party ledger marked ISPARTYLEDGER", !!partyBlock && /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/.test(partyBlock));
  check("party ledger amount is positive", !!partyBlock && partyBlock.includes(`<AMOUNT>${amt}</AMOUNT>`));
  check("bill allocation references the invoice", !!partyBlock && partyBlock.includes(`<NAME>${INVOICE}</NAME>`));
  check("bill allocation is Agst Ref", !!partyBlock && /<BILLTYPE>Agst Ref<\/BILLTYPE>/.test(partyBlock));

  console.log("");
  if (failures.length) {
    console.error(`FAIL — ${failures.length} assertion(s) failed:`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log("PASS — receipt-voucher path wired correctly (mock).");
  console.log("Reminder: still verify the XML against a REAL Tally receipt export before go-live.");
  process.exit(0);
}

/** Return the <LEDGERENTRIES.LIST>…</LEDGERENTRIES.LIST> block whose LEDGERNAME matches. */
function blockFor(xml: string, ledger: string, _party = false): string | null {
  const blocks = xml.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g) ?? [];
  for (const b of blocks) {
    if (b.includes(`<LEDGERNAME>${ledger}</LEDGERNAME>`)) return b;
  }
  return null;
}

main().catch((err) => {
  console.error("Test threw:", err);
  process.exit(1);
});
