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

export interface TallyReceiptResult {
  voucher_guid:   string;
  voucher_number: string;   // Tally's Receipt voucher number
  total_amount:   number;
  created_at:     string;
}

export interface TallyCreditNoteResult {
  voucher_guid:   string;
  voucher_number: string;   // Tally's Credit Note number
  total_amount:   number;
  irn:            string | null;
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
   * Check whether a ledger (e.g. a customer) exists in the target company.
   * Used to fail an invoice clearly when the customer's ledger isn't in Tally
   * yet (accounts must create it) rather than posting a broken voucher.
   */
  async ledgerExists(ledgerName: string): Promise<boolean> {
    const xml = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>List of Ledgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXml(this.targetCompany)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="List of Ledgers" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const res    = await this.post(xml);
    const target = normalize(ledgerName);
    // Ledger names appear as <LEDGER NAME="..."> attributes and/or <NAME> elements.
    for (const m of res.matchAll(/<LEDGER\b[^>]*?\bNAME="([^"]*)"/gi)) {
      if (normalize(m[1]) === target) return true;
    }
    for (const m of res.matchAll(/<NAME\b[^>]*>([\s\S]*?)<\/NAME>/gi)) {
      if (normalize(m[1]) === target) return true;
    }
    return false;
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
   * Create a missing Sundry Debtor ledger for this customer (#2 auto-create).
   * Only ever called after ledgerExists() returned false AND the auto-create
   * setting is ON — so it never duplicates an existing ledger. Populated with the
   * CRM's GST data (GSTIN, state, address) so the invoice carries correct GST.
   *
   * ── BEST-ESTIMATE — verify the master fields against a real exported ledger ──
   * The GST field names (GSTREGISTRATIONTYPE, LEDSTATENAME, PARTYGSTIN) are the
   * standard ones but not yet confirmed against an export from this company.
   * Returns true if Tally reports it created the master.
   */
  async ensurePartyLedger(params: {
    ledger_name:  string;
    gstin:        string | null;
    address:      string;
    state:        string;
    state_code:   string;
  }): Promise<boolean> {
    const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
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
    const created = Number(firstTag(res, "CREATED") || "0");
    const altered = Number(firstTag(res, "ALTERED") || "0");
    log.info(`Party ledger create "${params.ledger_name}": created=${created} altered=${altered}`);
    return created >= 1 || altered >= 1;
  }

  /**
   * Check whether a voucher with this idempotency key already exists in Tally.
   * Returns the existing voucher details if found, null if not found.
   *
   * How Tally exposes the idempotency key (confirmed from Day Book export sample):
   *
   *   1. As a VOUCHER opening-tag ATTRIBUTE:
   *        <VOUCHER REMOTEID="our-key" VCHKEY="..." ...>
   *      Tally maps our UDF:REMOTEID value onto its own REMOTEID attribute in
   *      Day Book exports. This is the primary match path.
   *
   *   2. As a child element (fallback — Tally version / config dependent):
   *        <REMOTEID>our-key</REMOTEID>
   *        <UDF:REMOTEID>our-key</UDF:REMOTEID>
   *
   * Our idempotency keys have the format "sales_voucher:<uuid>" or
   * "credit_note:<uuid>" — structurally different from Tally's own internal
   * GUIDs ("xxxxxxxx-xxxx-11d8-…"), so false-positive matches are impossible.
   *
   * Searches the full current financial year (April → March).
   * Fails open: if the Day Book query throws, returns null so the bridge
   * creates rather than silently drops the job.
   */
  async findExistingVoucher(idempotencyKey: string): Promise<{
    voucher_guid:   string;
    invoice_number: string;
    irn:            string | null;
  } | null> {
    log.debug(`check-before-create: searching for idempotency key ${idempotencyKey}`);

    try {
      const today        = new Date();
      const isAfterApril = today.getMonth() >= 3;         // getMonth() is 0-indexed; April = 3
      const fyStartYear  = isAfterApril ? today.getFullYear() : today.getFullYear() - 1;
      const fromDate     = `${fyStartYear}-04-01`;
      const toDate       = `${fyStartYear + 1}-03-31`;

      const xml = await this.exportDayBook(fromDate, toDate);
      const key = idempotencyKey.trim();

      for (const m of xml.matchAll(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi)) {
        const block = m[0];

        // Path 1 — REMOTEID as an attribute on the opening <VOUCHER ...> tag
        const openTag    = block.match(/<VOUCHER\b[^>]*>/i)?.[0] ?? "";
        const attrMatch  = openTag.match(/\bREMOTEID="([^"]*)"/i);
        const attrValue  = attrMatch?.[1]?.trim() ?? "";

        // Path 2 — REMOTEID as a child element (namespace stripped or kept)
        const childValue = (firstTag(block, "REMOTEID") || firstTag(block, "UDF:REMOTEID")).trim();

        if (attrValue !== key && childValue !== key) continue;

        const result = {
          voucher_guid:   firstTag(block, "GUID"),
          invoice_number: firstTag(block, "VOUCHERNUMBER"),
          irn:            firstTag(block, "IRN") || null,
        };
        log.info(`check-before-create HIT: invoice=${result.invoice_number} guid=${result.voucher_guid}`);
        return result;
      }

      log.debug(`check-before-create: not found in FY Day Book (${fromDate} → ${toDate})`);
      return null;
    } catch (err) {
      // Fail open — Day Book query failure must never prevent invoice creation
      log.warn(`check-before-create: Day Book query failed, proceeding with create. Error: ${err}`);
      return null;
    }
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
    const res = await this.exportDayBook(fromDate, toDate);
    const map = new Map<string, { irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr_code: string | null }>();

    for (const m of res.matchAll(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi)) {
      const block  = m[0];
      const number = firstTag(block, "VOUCHERNUMBER");
      if (!number) continue;
      map.set(number, {
        irn:            firstTag(block, "IRN") || null,
        ack_no:         firstTag(block, "IRNACKNO") || null,
        ack_date:       firstTag(block, "IRNACKDATE") || null,
        signed_qr_code: firstTag(block, "IRNQRCODE") || firstTag(block, "SIGNEDQRCODE") || null,
      });
    }
    return map;
  }

  /**
   * Read back a voucher's details by its internal MASTERID (== LASTVCHID from
   * the import response). Tally's create response doesn't return the invoice
   * number, so right after creating we look it up in the Day Book.
   */
  async getVoucherByMasterId(masterId: string, date: string): Promise<{
    invoice_number: string; guid: string;
    irn: string | null; ack_no: string | null; ack_date: string | null; signed_qr_code: string | null;
  }> {
    const target = masterId.trim();
    const res = await this.exportDayBook(date, date);

    for (const m of res.matchAll(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi)) {
      const block = m[0];
      if (firstTag(block, "MASTERID").trim() !== target) continue;
      return {
        invoice_number: firstTag(block, "VOUCHERNUMBER"),
        guid:           firstTag(block, "GUID"),
        irn:            firstTag(block, "IRN") || null,
        ack_no:         firstTag(block, "IRNACKNO") || null,
        ack_date:       firstTag(block, "IRNACKDATE") || null,
        signed_qr_code: firstTag(block, "IRNQRCODE") || firstTag(block, "SIGNEDQRCODE") || null,
      };
    }
    return { invoice_number: "", guid: "", irn: null, ack_no: null, ack_date: null, signed_qr_code: null };
  }

  /** Export the Day Book (all vouchers) for a date range as raw XML. */
  private async exportDayBook(fromDate: string, toDate: string): Promise<string> {
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
    return this.post(xml);
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
    narration_suffix?: string;          // optional payment summary from CRM (e.g. "Paid: Rs.17700 via Bank Transfer (Ref: HDFC001)")
  }): Promise<TallySalesResult> {

    const { idempotency_key, invoice_date, voucher_type, party_ledger, party_gstin,
            party_address, place_of_supply, stock_item, income_ledger,
            cgst_ledger, sgst_ledger, tax_percentage, line_items, narration_suffix } = params;

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

    const narration = narration_suffix
      ? `Inv to ${party_ledger} — ${invoice_date} | ${narration_suffix}`
      : `Inv to ${party_ledger} — ${invoice_date}`;

    const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
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
            <!-- Party (debit, total incl. tax).
                 BILLALLOCATIONS New Ref creates the bill reference in the party's
                 account so the receipt voucher can knock it off with Agst Ref.
                 NAME is empty — Tally auto-fills it with the assigned voucher number. -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(party_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${total.toFixed(2)}</AMOUNT>
              <BILLALLOCATIONS.LIST>
                <BILLTYPE>New Ref</BILLTYPE>
                <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
                <AMOUNT>-${total.toFixed(2)}</AMOUNT>
              </BILLALLOCATIONS.LIST>
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

    // Tally's import response gives result COUNTS (CREATED/ERRORS/EXCEPTIONS) and
    // LASTVCHID — NOT the invoice number. Verify the counts, then read the
    // assigned invoice number back by matching MASTERID == LASTVCHID in the Day Book.
    const created    = Number(firstTag(res, "CREATED") || "0");
    const errors     = Number(firstTag(res, "ERRORS") || "0");
    const exceptions = Number(firstTag(res, "EXCEPTIONS") || "0");

    if (created < 1 || errors > 0 || exceptions > 0) {
      throw new Error(
        `Tally did not create the voucher (created=${created}, errors=${errors}, ` +
        `exceptions=${exceptions}). Response: ${res.slice(0, 400)}`
      );
    }

    const lastVchId = firstTag(res, "LASTVCHID");
    if (!lastVchId) {
      throw new Error(`Tally created the voucher but returned no LASTVCHID. Response: ${res.slice(0, 400)}`);
    }

    // Read back the assigned invoice number (+ IRN if already present) from Tally
    const details = await this.getVoucherByMasterId(lastVchId, invoice_date);

    const voucherGuid    = details.guid || lastVchId;
    const invoiceNumber  = details.invoice_number;
    const irn            = details.irn;
    const ackNo          = details.ack_no;
    const ackDate        = details.ack_date;
    const signedQr       = details.signed_qr_code;
    const irnPending     = !irn;   // no IRN yet → B2B awaits it (mfg by accounts later)

    if (!invoiceNumber) {
      throw new Error(`Voucher created (vchid ${lastVchId}) but could not read back its invoice number.`);
    }

    log.info(`Voucher created: ${invoiceNumber} | vchid: ${lastVchId} | IRN: ${irn ?? "pending"}`);

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
   * Post a Receipt voucher to Tally (reverse-sync: a CRM payment → Tally Receipt).
   *
   * ── MATCHED TO REAL RECEIPTS (80-voucher Day Book export, May 2026) ─────────
   * Structure confirmed against real exported receipts from this company:
   *   - Parent VOUCHERTYPENAME = "Receipt", OBJVIEW = "Accounting Voucher View".
   *   - Entries use <ALLLEDGERENTRIES.LIST> (not LEDGERENTRIES.LIST).
   *   - Bank/cash DEBIT: ISDEEMEDPOSITIVE=Yes, AMOUNT negative.
   *   - Party CREDIT:   ISDEEMEDPOSITIVE=No, ISPARTYLEDGER=Yes, AMOUNT positive.
   *   - 47/80 receipts knock off the invoice via <BILLALLOCATIONS.LIST> with
   *     <BILLTYPE>Agst Ref</BILLTYPE> and <NAME> = the invoice number (e.g.
   *     "SD/A/26-27/93"). So bill-by-bill is the DEFAULT here; the CRM always
   *     knows the exact invoice. Set bill_by_bill=false for a plain on-account
   *     receipt (settings: tally_receipt_bill_by_bill).
   *   - 80/80 bank receipts carry a <BANKALLOCATIONS.LIST> (TRANSACTIONTYPE,
   *     TRANSFERMODE, UNIQUEREFERENCENUMBER). We emit one whenever bank_allocation
   *     is provided; omit it for a cash receipt ledger.
   *   - Receipts are MANUALLY numbered (VOUCHERNUMBER usually blank) — we identify
   *     them by GUID, not number.
   *
   * REMAINING REHEARSAL TUNE: the exact TRANSACTIONTYPE / TRANSFERMODE strings for
   * our payment modes (defaults "e-Fund Transfer" / "NEFT", both configurable). A
   * real receipt showed TRANSACTIONTYPE="Cheque/DD", TRANSFERMODE="NEFT" — confirm
   * what your bank ledger accepts on import during the dress rehearsal.
   * ───────────────────────────────────────────────────────────────────────────
   *
   * Tally sign convention (matches postSalesVoucher): a DEBIT entry is
   * ISDEEMEDPOSITIVE=Yes with a NEGATIVE amount; a CREDIT is ISDEEMEDPOSITIVE=No
   * with a positive amount. A receipt debits the bank/cash (money in) and credits
   * the party (settles the receivable).
   */
  async postReceiptVoucher(params: {
    idempotency_key: string;
    receipt_date:    string;            // YYYY-MM-DD
    voucher_type:    string;            // "Receipt" (or a custom receipt series name)
    party_ledger:    string;            // Sundry Debtor — credited
    receipt_ledger:  string;            // Bank/Cash account — debited (money received)
    invoice_number:  string;            // the Tally invoice this payment settles (bill ref)
    amount:          number;            // NET cash received (excludes any TDS)
    narration:       string;
    bill_by_bill?:   boolean;           // true (default) → Agst Ref allocation to the invoice
    tds_amount?:     number;            // customer's TDS deduction (0 = none)
    tds_ledger?:     string;            // TDS-receivable ledger, debited for tds_amount
    bank_allocation?: {                 // present → bank receipt; omit for a cash ledger
      transaction_type: string;         // e.g. "e-Fund Transfer", "Cheque/DD"
      transfer_mode:    string;         // e.g. "NEFT", "RTGS", "UPI"
      reference:        string;         // bank/UTR/instrument ref → UNIQUEREFERENCENUMBER
    } | null;
  }): Promise<TallyReceiptResult> {
    const { idempotency_key, receipt_date, voucher_type, party_ledger,
            receipt_ledger, invoice_number, amount, narration } = params;
    const billByBill = params.bill_by_bill !== false;   // default ON (matches real receipts)
    const bankAlloc  = params.bank_allocation ?? null;

    const tallyDate = receipt_date.replace(/-/g, "");   // YYYYMMDD
    const amt       = round2(amount);                   // net cash to the bank
    const tds       = round2(params.tds_amount || 0);   // customer's TDS deduction
    const tdsLedger = (tds > 0 && params.tds_ledger) ? params.tds_ledger : null;
    const gross     = round2(amt + tds);                // full invoice value settled

    // Bill allocation knocks the receipt off the specific invoice (Agst Ref) for the
    // FULL invoice value (net + TDS) so the bill clears. Real receipts use the invoice
    // number as <NAME>. Set bill_by_bill=false for a plain on-account receipt.
    const billAllocation = (billByBill && invoice_number) ? `
              <BILLALLOCATIONS.LIST>
                <NAME>${escapeXml(invoice_number)}</NAME>
                <BILLTYPE>Agst Ref</BILLTYPE>
                <AMOUNT>${gross.toFixed(2)}</AMOUNT>
              </BILLALLOCATIONS.LIST>` : "";

    // TDS split — the customer deducted TDS, so the bank got only the net. The TDS
    // is debited to the TDS-receivable ledger; party is credited the FULL (gross).
    const tdsEntry = tdsLedger ? `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(tdsLedger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${tds.toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>` : "";

    // Bank allocation — required by bank ledgers that capture transaction details
    // (all 80 sampled receipts have one). Omit for a cash receipt ledger.
    const bankAllocation = bankAlloc ? `
              <BANKALLOCATIONS.LIST>
                <DATE>${tallyDate}</DATE>
                <INSTRUMENTDATE>${tallyDate}</INSTRUMENTDATE>
                <TRANSACTIONTYPE>${escapeXml(bankAlloc.transaction_type)}</TRANSACTIONTYPE>
                <TRANSFERMODE>${escapeXml(bankAlloc.transfer_mode)}</TRANSFERMODE>
                ${bankAlloc.reference ? `<UNIQUEREFERENCENUMBER>${escapeXml(bankAlloc.reference)}</UNIQUEREFERENCENUMBER>` : ""}
                <PAYMENTFAVOURING>${escapeXml(party_ledger)}</PAYMENTFAVOURING>
                <AMOUNT>-${amt.toFixed(2)}</AMOUNT>
              </BANKALLOCATIONS.LIST>` : "";

    const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
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
          <VOUCHER VCHTYPE="${escapeXml(voucher_type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>${tallyDate}</DATE>
            <VOUCHERTYPENAME>${escapeXml(voucher_type)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${escapeXml(party_ledger)}</PARTYLEDGERNAME>
            <NARRATION>${escapeXml(narration)}</NARRATION>
            <!-- Idempotency key for check-before-create -->
            <UDF:REMOTEID.LIST TYPE="String">
              <UDF:REMOTEID>${escapeXml(idempotency_key)}</UDF:REMOTEID>
            </UDF:REMOTEID.LIST>
            <!-- Bank/Cash (debit — money received). Receipts use ALLLEDGERENTRIES.LIST
                 (accounting voucher view), per real exported receipts. -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(receipt_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amt.toFixed(2)}</AMOUNT>${bankAllocation}
            </ALLLEDGERENTRIES.LIST>${tdsEntry}
            <!-- Party (credit — settles the receivable for the FULL invoice value) -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(party_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>${gross.toFixed(2)}</AMOUNT>${billAllocation}
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const res = await this.post(xml);
    this.assertNoLineError(res, "postReceiptVoucher");

    const created    = Number(firstTag(res, "CREATED") || "0");
    const errors     = Number(firstTag(res, "ERRORS") || "0");
    const exceptions = Number(firstTag(res, "EXCEPTIONS") || "0");

    if (created < 1 || errors > 0 || exceptions > 0) {
      throw new Error(
        `Tally did not create the receipt (created=${created}, errors=${errors}, ` +
        `exceptions=${exceptions}). Response: ${res.slice(0, 400)}`
      );
    }

    const lastVchId = firstTag(res, "LASTVCHID");
    if (!lastVchId) {
      throw new Error(`Tally created the receipt but returned no LASTVCHID. Response: ${res.slice(0, 400)}`);
    }

    // Read back the GUID (receipts are manually numbered — VOUCHERNUMBER is usually
    // blank, so we do NOT require it). The GUID is the stable identifier we store.
    const details = await this.getVoucherByMasterId(lastVchId, receipt_date);
    const voucherGuid   = details.guid || lastVchId;
    // Prefer a real voucher number if present; otherwise fall back to the GUID.
    const voucherNumber = details.invoice_number || voucherGuid;

    log.info(`Receipt created: vchid ${lastVchId} | guid ${voucherGuid} | net ${amt.toFixed(2)}${tds > 0 ? ` + TDS ${tds.toFixed(2)} = ${gross.toFixed(2)}` : ""}`);

    return {
      voucher_guid:   voucherGuid,
      voucher_number: voucherNumber,
      total_amount:   gross,
      created_at:     new Date().toISOString(),
    };
  }

  /**
   * Post a Credit Note to Tally — REVERSES a sales invoice (CRM-first cancel).
   *
   * ── VERIFIED against a real credit note (CN/A/26-27/1, Apr 2026) ────────────
   * Item-invoice format (OBJVIEW="Invoice Voucher View", ISINVOICE=Yes) with the
   * signs flipped vs a sale — confirmed against the real export:
   *   - VOUCHERTYPENAME = the custom credit-note type (default "CREDIT NOTE-REG").
   *   - Party CREDITED: ISDEEMEDPOSITIVE=No, ISPARTYLEDGER=Yes, +total, with a
   *     <BILLALLOCATIONS.LIST> Agst Ref → the original invoice number (matched).
   *   - Income (inventory ACCOUNTINGALLOCATIONS) + CGST + SGST DEBITED:
   *     ISDEEMEDPOSITIVE=Yes, negative amounts (matched).
   *   - Original invoice also referenced via top-level <REFERENCE>/<REFERENCEDATE>
   *     (GST original-doc ref) — now emitted.
   * Credit notes get a real VOUCHERNUMBER (CN/A/… series) read back from the Day
   * Book. B2B credit notes carry an IRN (captured in the result if present; the
   * cancel does not gate on it — the reversal is effective once the voucher exists).
   * ───────────────────────────────────────────────────────────────────────────
   */
  async postCreditNote(params: {
    idempotency_key: string;
    credit_date:     string;            // YYYY-MM-DD
    voucher_type:    string;            // custom credit-note type, e.g. "CREDIT NOTE-REG"
    party_ledger:    string;
    party_gstin:     string;
    place_of_supply: string;
    stock_item:      string;
    income_ledger:   string;
    cgst_ledger:     string;
    sgst_ledger:     string;
    tax_percentage:  number;
    original_invoice: string;           // the invoice this note reverses
    original_invoice_date?: string;     // YYYY-MM-DD — GST original-doc reference date
    line_items:      Array<{ description: string; amount: number }>;
    narration:       string;
  }): Promise<TallyCreditNoteResult> {
    const { idempotency_key, credit_date, voucher_type, party_ledger, party_gstin,
            place_of_supply, stock_item, income_ledger, cgst_ledger, sgst_ledger,
            tax_percentage, original_invoice, original_invoice_date, line_items, narration } = params;

    const tallyDate = credit_date.replace(/-/g, "");
    const taxable   = round2(line_items.reduce((s, li) => s + li.amount, 0));
    const halfRate  = tax_percentage / 2 / 100;
    const cgst      = round2(taxable * halfRate);
    const sgst      = round2(taxable * halfRate);
    const total     = round2(taxable + cgst + sgst);

    // Inventory lines: income is DEBITED on a credit note (ISDEEMEDPOSITIVE=Yes, negative).
    const inventoryEntries = line_items.map((li) => `
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${escapeXml(stock_item)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${round2(li.amount).toFixed(2)}</AMOUNT>
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
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-${round2(li.amount).toFixed(2)}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>`).join("");

    const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
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
            ${party_gstin ? `<PARTYGSTIN>${escapeXml(party_gstin)}</PARTYGSTIN>` : ""}
            <PLACEOFSUPPLY>${escapeXml(place_of_supply)}</PLACEOFSUPPLY>
            <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>
            <ISINVOICE>Yes</ISINVOICE>
            ${original_invoice ? `<REFERENCE>${escapeXml(original_invoice)}</REFERENCE>` : ""}
            ${original_invoice_date ? `<REFERENCEDATE>${original_invoice_date.replace(/-/g, "")}</REFERENCEDATE>` : ""}
            <NARRATION>${escapeXml(narration)}</NARRATION>
            <UDF:REMOTEID.LIST TYPE="String">
              <UDF:REMOTEID>${escapeXml(idempotency_key)}</UDF:REMOTEID>
            </UDF:REMOTEID.LIST>
            ${inventoryEntries}
            <!-- Party (credit — reverses the receivable), Agst Ref to the original invoice -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(party_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>${total.toFixed(2)}</AMOUNT>
              ${original_invoice ? `<BILLALLOCATIONS.LIST>
                <NAME>${escapeXml(original_invoice)}</NAME>
                <BILLTYPE>Agst Ref</BILLTYPE>
                <AMOUNT>${total.toFixed(2)}</AMOUNT>
              </BILLALLOCATIONS.LIST>` : ""}
            </LEDGERENTRIES.LIST>
            <!-- Output CGST reversed (debit) -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(cgst_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${cgst.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>
            <!-- Output SGST reversed (debit) -->
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(sgst_ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${sgst.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const res = await this.post(xml);
    this.assertNoLineError(res, "postCreditNote");

    const created    = Number(firstTag(res, "CREATED") || "0");
    const errors     = Number(firstTag(res, "ERRORS") || "0");
    const exceptions = Number(firstTag(res, "EXCEPTIONS") || "0");
    if (created < 1 || errors > 0 || exceptions > 0) {
      throw new Error(
        `Tally did not create the credit note (created=${created}, errors=${errors}, ` +
        `exceptions=${exceptions}). Response: ${res.slice(0, 400)}`
      );
    }

    const lastVchId = firstTag(res, "LASTVCHID");
    if (!lastVchId) {
      throw new Error(`Tally created the credit note but returned no LASTVCHID. Response: ${res.slice(0, 400)}`);
    }

    const details = await this.getVoucherByMasterId(lastVchId, credit_date);
    const voucherGuid   = details.guid || lastVchId;
    const voucherNumber = details.invoice_number || voucherGuid;
    const irn           = details.irn;

    log.info(`Credit note created: ${voucherNumber} | vchid ${lastVchId} | reverses ${original_invoice} | IRN ${irn ?? "n/a"}`);

    return {
      voucher_guid:   voucherGuid,
      voucher_number: voucherNumber,
      total_amount:   total,
      irn,
      irn_pending:    !irn,    // same as postSalesVoucher — B2B credit notes also await IRN async
      created_at:     new Date().toISOString(),
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
    // Note: <ERRORS>N</ERRORS> in an import RESPONSE is a COUNT, not a message —
    // it is checked numerically by the caller, not here.
    // "Unknown Request" style failures have no <CREATED> and are caught by the
    // count check in postSalesVoucher.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read-only snapshot helpers (added in bridge 1.4.0).
  //
  // These read VOUCHER and LEDGER blocks from Tally for the handoff-v2 sync
  // pull (POSTs to /api/tally/sync-pull on the CRM). Purely additive — they
  // share the existing exportDayBook + post primitives and never mutate
  // anything in Tally.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Lists every voucher from the Day Book in a date range with the fields
   * the CRM's sync-pull endpoint expects. Used by SnapshotPoller.
   *
   * Returns sales, receipt, and credit-note vouchers in one pass; the
   * caller filters by voucher_kind based on Tally's VOUCHERTYPENAME.
   */
  async listVouchersForSnapshot(fromDate: string, toDate: string): Promise<Array<{
    voucher_master_id: string;
    voucher_kind: "sales" | "receipt" | "credit_note" | null;
    voucher_series: string | null;
    invoice_number: string | null;
    party_name: string | null;
    party_gstin: string | null;
    voucher_date: string | null;
    voucher_amount: number | null;
    irn: string | null;
    against_voucher: string | null;
    custom_fields: Record<string, string>;
  }>> {
    const xml = await this.exportDayBook(fromDate, toDate);
    const out: Array<{
      voucher_master_id: string;
      voucher_kind: "sales" | "receipt" | "credit_note" | null;
      voucher_series: string | null;
      invoice_number: string | null;
      party_name: string | null;
      party_gstin: string | null;
      voucher_date: string | null;
      voucher_amount: number | null;
      irn: string | null;
      against_voucher: string | null;
      custom_fields: Record<string, string>;
    }> = [];

    for (const m of xml.matchAll(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi)) {
      const block = m[0];
      const masterId = firstTag(block, "MASTERID").trim();
      if (!masterId) continue;

      const typeName = firstTag(block, "VOUCHERTYPENAME").toLowerCase();
      const kind: "sales" | "receipt" | "credit_note" | null =
        typeName.includes("credit note") ? "credit_note"
        : typeName.includes("receipt") ? "receipt"
        : typeName.includes("sales") || typeName.includes("invoice") ? "sales"
        : null;

      const amtRaw = firstTag(block, "AMOUNT")
        || firstTag(block, "INVOICETOTAL")
        || firstTag(block, "GROSSAMOUNT");
      const amount = amtRaw ? Number(amtRaw.replace(/[^\d.-]/g, "")) : NaN;

      const rawDate = firstTag(block, "DATE").trim();
      // Tally dates are YYYYMMDD; convert to ISO.
      const isoDate = /^\d{8}$/.test(rawDate)
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : null;

      // Receipt-specific: which sales voucher this receipt clears.
      const againstVoucher =
        firstTag(block, "BILLALLOCATIONS.LIST")
        // Fallback: look at any BILLNAME field inside the block
        || (block.match(/<BILLNAME>([\s\S]*?)<\/BILLNAME>/i)?.[1]?.trim() ?? "");

      // Custom fields — narration, voucher class, etc. Bridge captures
      // liberally; CRM decides what to surface.
      const customFields: Record<string, string> = {};
      const narration = firstTag(block, "NARRATION");
      if (narration) customFields.narration = narration;
      const voucherClass = firstTag(block, "CLASSNAME");
      if (voucherClass) customFields.voucher_class = voucherClass;
      const costCentre = firstTag(block, "COSTCENTRENAME");
      if (costCentre) customFields.cost_centre = costCentre;

      out.push({
        voucher_master_id: masterId,
        voucher_kind:      kind,
        voucher_series:    firstTag(block, "VOUCHERTYPENAME") || null,
        invoice_number:    firstTag(block, "VOUCHERNUMBER") || null,
        party_name:        firstTag(block, "PARTYLEDGERNAME") || firstTag(block, "PARTYNAME") || null,
        party_gstin:       firstTag(block, "PARTYGSTIN") || firstTag(block, "CONSIGNEEGSTIN") || null,
        voucher_date:      isoDate,
        voucher_amount:    Number.isFinite(amount) ? Math.abs(amount) : null,
        irn:               firstTag(block, "IRN") || null,
        against_voucher:   againstVoucher || null,
        custom_fields:     customFields,
      });
    }

    return out;
  }

  /**
   * Lists all Sundry Debtor ledgers (customer parties) with their GSTIN.
   * Used by SnapshotPoller for the party_master snapshot.
   */
  async listSundryDebtors(): Promise<Array<{ ledger_name: string; gstin: string | null; address: string | null }>> {
    const xml = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>List of Ledgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXml(this.targetCompany)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="List of Ledgers" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <FILTER>SundryDebtorsOnly</FILTER>
            <FETCH>NAME, PARTYGSTIN, MAILINGNAME, LEDSTATEADDRESS</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="SundryDebtorsOnly">$Parent = "Sundry Debtors"</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    const res = await this.post(xml);
    const out: Array<{ ledger_name: string; gstin: string | null; address: string | null }> = [];

    for (const m of res.matchAll(/<LEDGER\b[^>]*?\bNAME="([^"]*)"[\s\S]*?<\/LEDGER>/gi)) {
      const block = m[0];
      const name = collapse(m[1]);
      if (!name) continue;
      out.push({
        ledger_name: name,
        gstin:       firstTag(block, "PARTYGSTIN") || null,
        address:     firstTag(block, "LEDSTATEADDRESS") || null,
      });
    }
    return out;
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
