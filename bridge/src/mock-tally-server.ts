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
    if (body.includes("GetCurrentCompany") || body.includes("CurrentCompany") || body.includes("List of Companies")) {
      res.end(companyResponse("Sree Design Infrastructure Pvt Ltd", "33AAACU4245J1ZF"));
      return;
    }

    if (body.includes("REPORTNAME>All Masters") || body.includes("Sundry Debtors")) {
      // Party master creation
      res.end(`<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ALTERED>0</ALTERED></IMPORTRESULT></DATA></BODY></ENVELOPE>`);
      return;
    }

    if (body.includes("VCHTYPE") || body.includes("VOUCHER")) {
      // Sales voucher creation
      const invoiceNum = `TWV/24-25/${String(requestCount).padStart(4, "0")}`;
      const guid       = `fake-guid-${Date.now()}`;
      const irn        = simulate === "async_irn" ? null : `fake-irn-${Date.now()}`;

      if (irn) {
        res.end(voucherResponse(guid, invoiceNum, irn));
      } else {
        // Async IRN: no IRN in response — bridge should poll or wait
        res.end(voucherResponseNoIrn(guid, invoiceNum));
      }
      return;
    }

    // Default: empty OK
    res.end(`<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>0</CREATED><ALTERED>0</ALTERED></IMPORTRESULT></DATA></BODY></ENVELOPE>`);
  });
});

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
