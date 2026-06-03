/**
 * diagnose-tally.ts
 *
 * One-off diagnostic. Asks the local Tally for its list of companies and
 * prints the RAW XML response, so we can see the exact tag format your
 * Tally version uses for the company name.
 *
 * Run on the Tally server:
 *   cd C:\twv-tally-bridge\bridge
 *   npx ts-node src/diagnose-tally.ts
 *
 * Then copy the whole output and send it back.
 */

import http from "http";

const HOST = "localhost";
const PORT = 9000;

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

const body = Buffer.from(xml, "utf-8");
const req = http.request(
  { host: HOST, port: PORT, method: "POST", path: "/", timeout: 15000,
    headers: { "Content-Type": "text/xml;charset=utf-8", "Content-Length": body.length } },
  (res) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => (data += c));
    res.on("end", () => {
      console.log("\n===================== RAW TALLY RESPONSE (copy everything below) =====================\n");
      console.log(data);
      console.log("\n===================== END OF RESPONSE =====================\n");
      process.exit(0);
    });
  }
);
req.on("timeout", () => { req.destroy(); console.error("Tally timed out. Is it open?"); process.exit(1); });
req.on("error", (e) => { console.error("Could not reach Tally:", e.message); process.exit(1); });
req.write(body);
req.end();
