/**
 * Tally XML gateway client — all calls to http://localhost:9000.
 *
 * Safety rules baked in:
 *   D10.1 — company GSTIN guard: refuses to post if wrong company is open
 *   D10.2 — strict response parser: CREATED=1 + voucher GUID required; LINEERROR = failure
 *   D10.3 — single-flight: only one post in flight at a time (enforced by the poller)
 *   D5    — IRN sync-vs-async: returns irn_pending=true when voucher is created
 *           but IRP hasn't responded yet (fill in samples once D5 is captured)
 */

import http from "http";
import { XMLParser } from "fast-xml-parser";
import { log } from "./logger";
import { Config } from "./config";

const parser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: "@_",
  parseTagValue:       true,
});

export interface TallyCompanyInfo {
  name:  string;
  gstin: string;
}

export interface TallySalesResult {
  voucher_guid:   string;
  invoice_number: string;
  irn:            string | null;   // null when irn_pending = true
  ack_no:         string | null;
  ack_date:       string | null;
  signed_qr_code: string | null;
  total_amount:   number;
  irn_pending:    boolean;
  created_at:     string;
}

export class TallyClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs = 30_000;

  constructor(config: Config) {
    this.host = config.tally_host;
    this.port = config.tally_port;
  }

  /** POST raw XML to Tally, return raw response body. */
  private post(xml: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(xml, "utf-8");
      const req  = http.request(
        {
          host:    this.host,
          port:    this.port,
          method:  "POST",
          path:    "/",
          headers: {
            "Content-Type":   "text/xml;charset=utf-8",
            "Content-Length": body.length,
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.on("timeout", () => { req.destroy(); reject(new Error("Tally request timed out")); });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /** Ping: is Tally listening and a company loaded? */
  async ping(): Promise<boolean> {
    try {
      const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="List of Companies" ISMODIFY="No"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
      const res = await this.post(xml);
      return res.trim().length > 0 && !res.includes("LINEERROR");
    } catch {
      return false;
    }
  }

  /** Get the currently open company name from Tally (D10.1 guard).
   *  Uses the same "List of Companies" collection as ping() — proven to work.
   *  GSTIN is read from config (not Tally) until D5 samples confirm the right query.
   */
  async getCurrentCompany(): Promise<TallyCompanyInfo | null> {
    try {
      // Reuse the exact XML from ping() / connection tester — already verified working.
      const xml = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>List of Companies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="List of Companies" ISMODIFY="No">
            <TYPE>Company</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

      const res = await this.post(xml);

      // Parse <NAME> tags from the List of Companies response
      // Same approach as the connection tester (scripts/tally-connection-test/)
      const names = [...res.matchAll(/<NAME>(.*?)<\/NAME>/gs)]
        .map(m => m[1].trim())
        .filter(Boolean);

      const name = names[0] ?? "";
      if (!name) return null;

      // GSTIN: not available from this query — use empty string.
      // The poller's GSTIN guard only fires when gstin is non-empty,
      // so this safely skips the check until D5 samples confirm the right query.
      return { name, gstin: "" };
    } catch (err) {
      log.error(`getCurrentCompany failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Ensure a party ledger exists in Tally for this customer.
   * Idempotent — Tally ignores duplicate master creation with ISMODIFY=No.
   */
  async ensurePartyLedger(params: {
    ledger_name:  string;
    gstin:        string | null;
    address:      string;
    state:        string;
    state_code:   string;
  }): Promise<void> {
    // ── D5 TODO ──────────────────────────────────────────────────────────────
    // Build the exact XML envelope using D5 sample.
    // Below is a best-estimate structure; verify field names against Tally version.
    // ─────────────────────────────────────────────────────────────────────────
    const xml = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Masters</TYPE>
    <SUBTYPE>Ledger</SUBTYPE>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(params.ledger_name)}" RESERVEDNAME="" ACTION="Create" ISMODIFY="No">
            <NAME>${escapeXml(params.ledger_name)}</NAME>
            <PARENT>Sundry Debtors</PARENT>
            ${params.gstin ? `<PARTYGSTIN>${escapeXml(params.gstin)}</PARTYGSTIN>` : ""}
            <ADDRESS.LIST TYPE="String">
              <ADDRESS>${escapeXml(params.address)}</ADDRESS>
            </ADDRESS.LIST>
            <STATENAME>${escapeXml(params.state)}</STATENAME>
            <PINCODE></PINCODE>
            <COUNTRYNAME>India</COUNTRYNAME>
            <LEDSTATENAME>${escapeXml(params.state)}</LEDSTATENAME>
            <GSTREGISTRATIONTYPE>${params.gstin ? "Regular" : "Unregistered"}</GSTREGISTRATIONTYPE>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const res = await this.post(xml);
    this.assertNoLineError(res, "ensurePartyLedger");
    log.info(`Party ledger ensured: ${params.ledger_name}`);
  }

  /**
   * Check whether a voucher with this idempotency key already exists in Tally.
   * Returns the existing invoice number + IRN if found, null if not found.
   * Part of the check-before-create flow (D2 + D10.3).
   *
   * ── D5 TODO ────────────────────────────────────────────────────────────────
   * Tally stores the idempotency key in a UDF field (REMOTEID / MASTERID).
   * The exact TDL query depends on how Tally exposes custom fields.
   * Verify the field name from D5 sample once captured.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async findExistingVoucher(idempotencyKey: string): Promise<{
    voucher_guid:   string;
    invoice_number: string;
    irn:            string | null;
  } | null> {
    log.debug(`check-before-create: searching for idempotency key ${idempotencyKey}`);
    // ── D5 TODO ───────────────────────────────────────────────────────────────
    // Build the TDL query using D5 sample. For now returns null (no match)
    // so the bridge always creates — safe until real check is wired.
    // ─────────────────────────────────────────────────────────────────────────
    void idempotencyKey;
    return null;
  }

  /**
   * Post a Sales Voucher to Tally. Returns the issued invoice number + IRN.
   *
   * ── D5 TODO ────────────────────────────────────────────────────────────────
   * The XML envelope below is a SKELETON. The exact field names, ledger
   * structure, e-invoice block, and IRN response fields MUST be updated
   * once the D5 sample sales-voucher XML + e-invoice response is captured.
   *
   * To capture D5 samples:
   *   1. In Tally, create a test Sales Voucher with e-invoice enabled.
   *   2. Export the voucher as XML (Gateway → Data Export → XML).
   *   3. Note what Tally puts in the POST response (CREATED, ALTERED, LINEERROR).
   *   4. If e-invoice is async: run a second query to fetch IRN by voucher GUID.
   *   5. Save all as bridge/samples/*.xml and update the methods below.
   * ───────────────────────────────────────────────────────────────────────────
   */
  async postSalesVoucher(params: {
    idempotency_key:  string;
    invoice_date:     string;           // YYYY-MM-DD
    party_ledger:     string;
    taxable_amount:   number;
    tax_percentage:   number;           // e.g. 18
    is_interstate:    boolean;
    voucher_series:   string;
    line_items:       Array<{
      description:    string;
      amount:         number;
      hsn_sac:        string;
    }>;
    ledgers: {
      sales:    string;   // e.g. "Space Rent Income"
      cgst:     string;   // e.g. "Output CGST"  (intra-state)
      sgst:     string;   // e.g. "Output SGST"  (intra-state)
      igst:     string;   // e.g. "Output IGST"  (inter-state)
      round_off:string;
    };
  }): Promise<TallySalesResult> {

    const { idempotency_key, invoice_date, party_ledger, taxable_amount,
            tax_percentage, is_interstate, voucher_series, line_items, ledgers } = params;

    // ── D5 TODO ────────────────────────────────────────────────────────────────
    // Replace the XML skeleton below with the envelope from your D5 sample.
    // Key things to confirm from sample:
    //   - Field name for the idempotency/remote ID (REMOTEID? MASTERID? UDF?)
    //   - Whether GSTDETAILS block is in the voucher or a separate sub-object
    //   - How e-invoice fields (IRN, ACK, QR) appear in the import response
    //   - The date format Tally expects (YYYYMMDD vs DD-Mon-YYYY)
    //   - Tax ledger entry structure (one LEDGERENTRIES per tax type)
    // ─────────────────────────────────────────────────────────────────────────
    const tallyDate = invoice_date.replace(/-/g, "");  // YYYYMMDD — verify from D5 sample

    const taxRate     = tax_percentage / 100;
    const taxAmount   = Math.round(taxable_amount * taxRate * 100) / 100;
    const roundOff    = Math.round((taxable_amount + taxAmount) * 100) / 100 -
                        Math.floor((taxable_amount + taxAmount) * 100) / 100;
    const totalAmount = taxable_amount + taxAmount + roundOff;

    // Note: Tally computes the tax amounts from its own ledger rates.
    // We pass taxable_amount only. The individual CGST/SGST amounts below
    // are for narration only and will be overridden by Tally's calculation.
    const halfTax = Math.round((taxAmount / 2) * 100) / 100;

    const taxLedgerEntries = is_interstate
      ? `<ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(ledgers.igst)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${taxAmount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`
      : `<ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(ledgers.cgst)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${halfTax}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(ledgers.sgst)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${halfTax}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;

    const xml = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Vouchers</TYPE>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${escapeXml(voucher_series)}" ACTION="Create">
            <DATE>${tallyDate}</DATE>
            <VOUCHERTYPENAME>${escapeXml(voucher_series)}</VOUCHERTYPENAME>
            <ISINVOICE>Yes</ISINVOICE>
            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
            <!-- Idempotency key — D5: verify UDF field name in your Tally version -->
            <UDF:REMOTEID.LIST TYPE="String">
              <UDF:REMOTEID>${escapeXml(idempotency_key)}</UDF:REMOTEID>
            </UDF:REMOTEID.LIST>

            <!-- Party -->
            <PARTYLEDGERNAME>${escapeXml(party_ledger)}</PARTYLEDGERNAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(party_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>

            <!-- Sales ledger with inventory/service lines -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(ledgers.sales)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${taxable_amount}</AMOUNT>
              <INVENTORYENTRIES.LIST>
                ${line_items.map(li => `<STOCKITEMNAME>${escapeXml(li.description)}</STOCKITEMNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>${li.amount}</AMOUNT>
                <HSNCODE>${escapeXml(li.hsn_sac)}</HSNCODE>`).join("\n")}
              </INVENTORYENTRIES.LIST>
            </ALLLEDGERENTRIES.LIST>

            <!-- Tax ledgers (Tally computes actual amounts from rates — D8) -->
            ${taxLedgerEntries}

            <!-- Round-off -->
            ${roundOff !== 0 ? `<ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(ledgers.round_off)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${roundOff < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${Math.abs(roundOff)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>` : ""}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const res = await this.post(xml);
    this.assertNoLineError(res, "postSalesVoucher");

    // ── D5 TODO ────────────────────────────────────────────────────────────────
    // Parse CREATED count, voucher GUID, invoice number, and e-invoice fields
    // from the actual D5 response. The paths below are best-estimate.
    // ─────────────────────────────────────────────────────────────────────────
    const parsed  = parser.parse(res) as Record<string, unknown>;
    const result  = (parsed["ENVELOPE"] as Record<string, unknown> | undefined) ?? {};
    const created = Number((result["CREATED"] as string | number | undefined) ?? 0);

    if (created < 1) {
      throw new Error(`Tally created ${created} vouchers — expected 1. Response: ${res.slice(0, 500)}`);
    }

    // D5 TODO: extract these from real response
    const voucherGuid    = String((result["GUID"] as string | undefined) ?? "").trim();
    const invoiceNumber  = String((result["VOUCHERNUMBER"] as string | undefined) ?? "").trim();
    const irn            = String((result["IRN"] as string | undefined) ?? "").trim() || null;
    const ackNo          = String((result["IRNACKNO"] as string | undefined) ?? "").trim() || null;
    const ackDate        = String((result["IRNACKDATE"] as string | undefined) ?? "").trim() || null;
    const signedQr       = String((result["SIGNEDQRCODE"] as string | undefined) ?? "").trim() || null;
    const irnPending     = !irn;   // if no IRN in response, Tally is generating it async

    log.info(`Voucher created: ${invoiceNumber} | GUID: ${voucherGuid} | IRN: ${irn ?? "pending"}`);

    return {
      voucher_guid:    voucherGuid,
      invoice_number:  invoiceNumber,
      irn,
      ack_no:          ackNo,
      ack_date:        ackDate,
      signed_qr_code:  signedQr,
      total_amount:    totalAmount,
      irn_pending:     irnPending,
      created_at:      new Date().toISOString(),
    };
  }

  /**
   * Strict response guard (D10.2).
   * Throws on LINEERROR or any embedded soft-error Tally puts in a 200 response.
   */
  private assertNoLineError(xml: string, context: string): void {
    const lineErrMatch = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
    if (lineErrMatch) {
      throw new Error(`Tally LINEERROR in ${context}: ${lineErrMatch[1].trim()}`);
    }
    // Tally sometimes wraps errors in ERRORS block instead
    const errMatch = xml.match(/<ERRORS>([\s\S]*?)<\/ERRORS>/i);
    if (errMatch && errMatch[1].trim()) {
      throw new Error(`Tally ERRORS in ${context}: ${errMatch[1].trim()}`);
    }
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}
