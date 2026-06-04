/**
 * Mock Tally XML server for testing the bridge without a real Tally instance.
 *
 * Run standalone: npx ts-node src/mock-tally-server.ts
 *
 * Simulates:
 *   - Company info response (returns configured GSTIN)
 *   - Sales voucher creation (returns fake invoice number + IRN)
 *   - Party master creation (always succeeds)
 *   - Error response (POST with ?simulate=error in URL)
 *   - Wrong company (POST with ?simulate=wrong_company)
 *   - Async IRN (POST with ?simulate=async_irn — returns no IRN on first call)
 *
 * Usage in tests: start this server on port 9000 before running the bridge.
 */

import fs from "fs";
import http from "http";

const PORT = parseInt(process.env.MOCK_PORT ?? "9000", 10);

let requestCount = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    requestCount++;
    const url = req.url ?? "";
    const simulate = new URLSearchParams(url.split("?")[1] ?? "").get("simulate");

    console.log(`[mock-tally] #${requestCount} ${req.method} ${url}`);

    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });

    // Simulate wrong company
    if (simulate === "wrong_company") {
      res.end(companyResponse("Wrong Company Ltd", "27ZZZZZ9999Z1ZA"));
      return;
    }

    // Simulate LINEERROR
    if (simulate === "error") {
      res.end(`<ENVELOPE><BODY><DATA><LINEERROR>Ledger 'Usage Income' not found in Tally</LINEERROR></DATA></BODY></ENVELOPE>`);
      return;
    }

    // Detect request type from body
    if (body.includes("List of Companies")) {
      res.end(companyResponse("Sree Design Infrastructure Pvt Ltd", "33AAACU4245J1ZF"));
      return;
    }

    // Day Book export — return all created mock vouchers (for read-back of
    // invoice number + IRN, matching real Tally's MASTERID/VOUCHERNUMBER format).
    if (body.includes("Day Book")) {
      res.end(dayBookResponse());
      return;
    }

    if (body.includes("REPORTNAME>All Masters") || body.includes("Sundry Debtors")) {
      res.end(importResult(1));   // party master created
      return;
    }

    if (body.includes("VCHTYPE") || body.includes("VOUCHER")) {
      // Voucher creation — save received XML for debug; assign a mock masterid +
      // voucher number, return real-style counts + LASTVCHID.
      const isReceipt = /<VOUCHERTYPENAME>\s*Receipt/i.test(body) || /VCHTYPE="Receipt"/i.test(body);
      try { fs.writeFileSync(isReceipt ? "/tmp/last-receipt.xml" : "/tmp/last-voucher.xml", body); } catch { /* ignore */ }
      mockVchId += 1;
      if (isReceipt) {
        // Receipts get a receipt-series number and never carry an IRN.
        const number = `RCT/26-27/MOCK${mockVchId}`;
        mockVouchers.push({ masterid: String(mockVchId), number, irn: "", vchtype: "Receipt" });
        res.end(importResult(1, String(mockVchId)));
        return;
      }
      const number = `SD/A/26-27/MOCK${mockVchId}`;
      // B2C (no IRN) unless ?simulate=irn, which fills the IRN immediately.
      const irn = simulate === "irn" ? `MOCKIRN${mockVchId}` : "";
      mockVouchers.push({ masterid: String(mockVchId), number, irn, vchtype: "SDIPL-REG" });
      res.end(importResult(1, String(mockVchId)));
      return;
    }

    res.end(importResult(0));
  });
});

let mockVchId = 90000;
const mockVouchers: Array<{ masterid: string; number: string; irn: string; vchtype: string }> = [];

function importResult(created: number, lastVchId = "0"): string {
  return `<RESPONSE><CREATED>${created}</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED>` +
    `<LASTVCHID>${lastVchId}</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED>` +
    `<IGNORED>0</IGNORED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>`;
}

function dayBookResponse(): string {
  const vouchers = mockVouchers.map((v) =>
    `<VOUCHER VCHTYPE="${v.vchtype}" ACTION="Create">` +
    `<DATE>20260603</DATE><MASTERID>${v.masterid}</MASTERID>` +
    `<VOUCHERNUMBER>${v.number}</VOUCHERNUMBER><GUID>mock-guid-${v.masterid}</GUID>` +
    `<IRN>${v.irn}</IRN><IRNACKNO>${v.irn ? "MOCKACK" : ""}</IRNACKNO>` +
    `<IRNACKDATE>${v.irn ? "2026-06-03" : ""}</IRNACKDATE><IRNQRCODE>${v.irn ? "MOCKQR" : ""}</IRNQRCODE>` +
    `</VOUCHER>`
  ).join("");
  return `<ENVELOPE><BODY><DATA><TALLYMESSAGE>${vouchers}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

function companyResponse(name: string, _gstin: string): string {
  // Mimics real Tally "List of Companies" — multiple companies open at once,
  // each as <COMPANY NAME="..."> (the real format). The target may not be first.
  const others = name === "Wrong Company Ltd"
    ? [name]
    : ["Recordsguru Information Management Pvt Ltd", name, "Stonecolour Exim Pvt Ltd"];
  const companies = others.map((n) =>
    `<COMPANY NAME="${n}" RESERVEDNAME=""><NAME TYPE="String">${n}</NAME></COMPANY>`
  ).join("");
  return `<ENVELOPE><BODY><DATA><COLLECTION>${companies}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

function voucherResponse(guid: string, invoiceNumber: string, irn: string): string {
  return `<ENVELOPE>
  <BODY>
    <DATA>
      <IMPORTRESULT>
        <CREATED>1</CREATED>
        <ALTERED>0</ALTERED>
      </IMPORTRESULT>
      <GUID>${guid}</GUID>
      <VOUCHERNUMBER>${invoiceNumber}</VOUCHERNUMBER>
      <IRN>${irn}</IRN>
      <IRNACKNO>fake-ack-${Date.now()}</IRNACKNO>
      <IRNACKDATE>${new Date().toISOString().split("T")[0]}</IRNACKDATE>
      <SIGNEDQRCODE>fake-qr-data-${Date.now()}</SIGNEDQRCODE>
    </DATA>
  </BODY>
</ENVELOPE>`;
}

function voucherResponseNoIrn(guid: string, invoiceNumber: string): string {
  return `<ENVELOPE>
  <BODY>
    <DATA>
      <IMPORTRESULT>
        <CREATED>1</CREATED>
        <ALTERED>0</ALTERED>
      </IMPORTRESULT>
      <GUID>${guid}</GUID>
      <VOUCHERNUMBER>${invoiceNumber}</VOUCHERNUMBER>
    </DATA>
  </BODY>
</ENVELOPE>`;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock Tally server running on http://localhost:${PORT}`);
  console.log(`Simulations: append ?simulate=error|wrong_company|async_irn to trigger`);
});
