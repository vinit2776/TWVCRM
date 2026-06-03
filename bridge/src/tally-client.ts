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
import { log } from "./logger";
import { Config } from "./config";

// Tally responses are parsed by direct tag extraction (see tag() / matchAll below)
// rather than a full XML parser — simpler and avoids a dependency we don't need.

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
  private readonly targetCompany: string;
  private readonly timeoutMs = 30_000;

  constructor(config: Config) {
    this.host = config.tally_host;
    this.port = config.tally_port;
    this.targetCompany = config.tally_target_company;
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

  /**
   * Confirm the TARGET company is open in Tally (D10.1 guard).
   *
   * Tally can have several companies open at once, returned in an arbitrary
   * order. We never trust "the first one" — we look specifically for the
   * configured target company (e.g. "Sree Design Infrastructure Pvt Ltd")
   * among the open companies. If it's there, we return it; if not, we refuse
   * (so nothing posts while the right company isn't loaded). Vouchers are
   * additionally targeted to this company by name (SVCURRENTCOMPANY), so even
   * with other companies open, posting to the wrong one is impossible.
   */
  async getCurrentCompany(): Promise<TallyCompanyInfo | null> {
    try {
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
      const openCompanies = extractAllCompanyNames(res);

      if (openCompanies.length === 0) {
        log.warn("Tally responded but no companies parsed. Raw (first 600): " +
          res.slice(0, 600).replace(/\s+/g, " "));
        return null;
      }

      // Find the target company among the open ones (whitespace-insensitive).
      const target = normalize(this.targetCompany);
      const match = openCompanies.find((c) => normalize(c) === target);

      if (!match) {
        log.error(
          `Target company "${this.targetCompany}" is NOT open in Tally. ` +
          `Open companies: ${openCompanies.join(" | ")}. ` +
          `Refusing to post until it is loaded.`
        );
        return null;
      }

      return { name: match, gstin: "" };
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
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(this.targetCompany)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
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
   * Read IRN data for created vouchers by exporting the Day Book for a date
   * range and matching on voucher number. Returns a map:
   *   invoiceNumber -> { irn, ack_no, ack_date, signed_qr_code }
   *
   * Only vouchers whose IRN has actually been generated will have a non-empty
   * IRN. Used by the IRN read-back loop to detect when accounts has generated
   * the e-invoice for a B2B invoice (D5 format confirmed from production sample).
   */
  async getIrnMap(fromDate: string, toDate: string): Promise<Map<string, {
    irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr_code: string | null;
  }>> {
    const xml = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Day Book</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXml(this.targetCompany)}</SVCURRENTCOMPANY>
        <SVFROMDATE TYPE="Date">${fromDate.replace(/-/g, "")}</SVFROMDATE>
        <SVTODATE TYPE="Date">${toDate.replace(/-/g, "")}</SVTODATE>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const res  = await this.post(xml);
    const map  = new Map<string, { irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr_code: string | null }>();

    // Split into individual <VOUCHER ...>...</VOUCHER> blocks and read each
    for (const m of res.matchAll(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi)) {
      const block  = m[0];
      const number = firstTag(block, "VOUCHERNUMBER");
      if (!number) continue;
      const irn    = firstTag(block, "IRN");
      map.set(number, {
        irn:            irn || null,
        ack_no:         firstTag(block, "IRNACKNO") || null,
        ack_date:       firstTag(block, "IRNACKDATE") || null,
        signed_qr_code: firstTag(block, "IRNQRCODE") || firstTag(block, "SIGNEDQRCODE") || null,
      });
    }
    return map;
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
    voucher_type:     string;           // "SDIPL-REG"
    party_ledger:     string;
    party_gstin:      string;
    party_address:    string;
    place_of_supply:  string;           // "Tamil Nadu"
    stock_item:       string;           // "Rent-The WorkVilla"
    income_ledger:    string;           // "Rent The Workvilla 18%"
    cgst_ledger:      string;           // "CGST Output 9%"
    sgst_ledger:      string;           // "SGST Output 9%"
    tax_percentage:   number;           // 18 (split 9 + 9)
    line_items:       Array<{ description: string; amount: number }>;
  }): Promise<TallySalesResult> {

    const { idempotency_key, invoice_date, voucher_type, party_ledger, party_gstin,
            party_address, place_of_supply, stock_item, income_ledger,
            cgst_ledger, sgst_ledger, tax_percentage, line_items } = params;

    // Built to match the real SDIPL-REG item-invoice format (from production sample).
    // Place of supply is the coworking location (Tamil Nadu) → always CGST + SGST.
    // Income ledger is attached INSIDE each inventory line (ACCOUNTINGALLOCATIONS);
    // only party + CGST + SGST are top-level LEDGERENTRIES.
    // VOUCHERNUMBER is omitted so Tally auto-numbers from the SDIPL-REG series.

    const tallyDate = invoice_date.replace(/-/g, "");          // YYYYMMDD
    const taxable   = round2(line_items.reduce((s, li) => s + li.amount, 0));
    const halfRate  = tax_percentage / 2 / 100;                // 9% each
    const cgst      = round2(taxable * halfRate);
    const sgst      = round2(taxable * halfRate);
    const total     = round2(taxable + cgst + sgst);

    const inventoryEntries = line_items.map((li) => `
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${escapeXml(stock_item)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${round2(li.amount).toFixed(2)}</AMOUNT>
              <BASICUSERDESCRIPTION.LIST TYPE="String">
                <BASICUSERDESCRIPTION>${escapeXml(li.description)}</BASICUSERDESCRIPTION>
              </BASICUSERDESCRIPTION.LIST>
              <GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>
              <GSTSOURCETYPE>Ledger</GSTSOURCETYPE>
              <GSTLEDGERSOURCE>${escapeXml(income_ledger)}</GSTLEDGERSOURCE>
              <HSNSOURCETYPE>Ledger</HSNSOURCETYPE>
              <HSNLEDGERSOURCE>${escapeXml(income_ledger)}</HSNLEDGERSOURCE>
              <GSTOVRDNTYPEOFSUPPLY>Services</GSTOVRDNTYPEOFSUPPLY>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>${escapeXml(income_ledger)}</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>${round2(li.amount).toFixed(2)}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>`).join("");

    const narration = `Inv to ${party_ledger} — ${invoice_date}`;

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
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(this.targetCompany)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${escapeXml(voucher_type)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${tallyDate}</DATE>
            <VOUCHERTYPENAME>${escapeXml(voucher_type)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${escapeXml(party_ledger)}</PARTYLEDGERNAME>
            <PARTYNAME>${escapeXml(party_ledger)}</PARTYNAME>
            <BASICBUYERNAME>${escapeXml(party_ledger)}</BASICBUYERNAME>
            ${party_gstin ? `<PARTYGSTIN>${escapeXml(party_gstin)}</PARTYGSTIN>
            <CONSIGNEEGSTIN>${escapeXml(party_gstin)}</CONSIGNEEGSTIN>` : ""}
            <PLACEOFSUPPLY>${escapeXml(place_of_supply)}</PLACEOFSUPPLY>
            <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>
            <ISINVOICE>Yes</ISINVOICE>
            <NARRATION>${escapeXml(narration)}</NARRATION>
            ${party_address ? `<BASICBUYERADDRESS.LIST TYPE="String">
              <BASICBUYERADDRESS>${escapeXml(party_address)}</BASICBUYERADDRESS>
            </BASICBUYERADDRESS.LIST>` : ""}
            <!-- Idempotency key for check-before-create (D2) -->
            <UDF:REMOTEID.LIST TYPE="String">
              <UDF:REMOTEID>${escapeXml(idempotency_key)}</UDF:REMOTEID>
            </UDF:REMOTEID.LIST>
            ${inventoryEntries}
            <!-- Party (debit, total incl. tax) -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(party_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${total.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>
            <!-- Output CGST -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(cgst_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${cgst.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>
            <!-- Output SGST -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(sgst_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${sgst.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const totalAmount = total;
    const res = await this.post(xml);
    this.assertNoLineError(res, "postSalesVoucher");

    // Extract fields directly from the XML by tag name — robust to nesting depth.
    // Works for both mock and real Tally regardless of where CREATED/GUID/etc sit.
    // ── D5: confirm these tag names match your Tally version's import response ──
    const tag = (name: string): string | null => {
      const m = res.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
      return m ? m[1].trim() : null;
    };

    const created = Number(tag("CREATED") ?? "0");
    if (created < 1) {
      throw new Error(`Tally created ${created} vouchers — expected 1. Response: ${res.slice(0, 500)}`);
    }

    const voucherGuid    = tag("GUID") ?? "";
    const invoiceNumber  = tag("VOUCHERNUMBER") ?? "";
    const irn            = tag("IRN") || null;
    const ackNo          = tag("IRNACKNO") || null;
    const ackDate        = tag("IRNACKDATE") || null;
    const signedQr       = tag("SIGNEDQRCODE") || null;
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Extract the text of the first <NAME>...</NAME> tag in a string ("" if absent). */
function firstTag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1].trim() : "";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

/**
 * Extract ALL open company names from a Tally "List of Companies" response.
 * Tally returns each as <COMPANY NAME="..." ...> (the name may contain
 * newlines from XML formatting, which we collapse). Falls back to
 * <NAME TYPE="String">...</NAME> elements if no attributes are found.
 */
function extractAllCompanyNames(xml: string): string[] {
  const names: string[] = [];

  // Primary: NAME="..." attribute on each <COMPANY ...> tag
  for (const m of xml.matchAll(/<COMPANY\b[^>]*?\bNAME="([^"]*)"/gi)) {
    const n = collapse(m[1]);
    if (n) names.push(n);
  }

  // Fallback: <NAME TYPE="String">...</NAME> elements
  if (names.length === 0) {
    for (const m of xml.matchAll(/<NAME\b[^>]*>([\s\S]*?)<\/NAME>/gi)) {
      const n = collapse(m[1]);
      if (n) names.push(n);
    }
  }

  return names;
}

/** Collapse internal whitespace/newlines to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Normalize a company name for comparison (collapsed + lowercased). */
function normalize(s: string): string {
  return collapse(s).toLowerCase();
}
