#!/usr/bin/env node
/*
 * test-tally.mjs
 * ------------------------------------------------------------------
 * Standalone CONNECTION TEST between this machine and Tally Prime's
 * XML gateway. Read-only: it changes NOTHING in Tally and NOTHING in
 * the CRM. It only asks Tally "are you there?" and "which companies
 * are open?" and prints the result.
 *
 * Use this version when testing from a Mac/Linux box or any machine
 * with Node installed (e.g. another office PC on the same network).
 * For the Windows Tally machine itself, Test-TallyConnection.ps1 is
 * simpler (no Node needed).
 *
 * USAGE
 *   node test-tally.mjs                 # talks to localhost:9000
 *   node test-tally.mjs 192.168.1.50    # Tally machine's IP
 *   node test-tally.mjs 192.168.1.50 9000
 *
 * NOTE: This must run on a machine that can REACH the Tally PC over
 * the LAN. It will NOT work from the cloud CRM (Vercel) — that gap
 * is exactly what the full bridge connector solves later.
 * ------------------------------------------------------------------
 */

import http from "node:http";

const host = process.argv[2] || "localhost";
const port = parseInt(process.argv[3] || "9000", 10);

const requestXml = `<ENVELOPE>
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

const line = "===================================================";
console.log(`\n${line}`);
console.log("  TWV CRM  <->  Tally   Connection Test");
console.log(line);
console.log(`  Target : http://${host}:${port}`);
console.log(`  Time   : ${new Date().toString()}\n`);

function fail(msg, hints = []) {
  console.error(`  RESULT: FAILED - ${msg}`);
  if (hints.length) {
    console.error("\n  Likely causes:");
    hints.forEach((h) => console.error(`   - ${h}`));
  }
  process.exit(1);
}

console.log(`[1/1] Sending read-only XML request to Tally ...`);

const req = http.request(
  {
    host,
    port,
    method: "POST",
    path: "/",
    headers: {
      "Content-Type": "text/xml;charset=utf-8",
      "Content-Length": Buffer.byteLength(requestXml),
    },
    timeout: 15000,
  },
  (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      if (!body || !body.trim()) {
        console.log("  RESULT: WARNING - Tally replied but the response was empty.");
        console.log("  -> Usually means no company is loaded. Open a company and retry.");
        process.exit(2);
      }

      const lineErr = body.match(/<LINEERROR>(.*?)<\/LINEERROR>/s);
      if (lineErr) {
        console.log(`  RESULT: Tally replied with an error: ${lineErr[1].trim()}`);
        console.log("  -> The connection WORKS, but check that a company is open.");
        process.exit(2);
      }

      const names = [...body.matchAll(/<NAME>(.*?)<\/NAME>/gs)].map((m) =>
        m[1].trim()
      );

      console.log("  RESULT: OK - Tally responded successfully!\n");
      console.log("  -------------------------------------------");
      console.log("   Companies currently open in Tally:");
      const unique = [...new Set(names)].filter(Boolean);
      if (unique.length) {
        unique.forEach((n) => console.log(`     - ${n}`));
      } else {
        console.log("     (Tally replied, but no company names were parsed.");
        console.log("      Connection is fine; a company may not be loaded.)");
      }
      console.log("  -------------------------------------------\n");
      console.log("  >>> CONNECTION TEST PASSED. The pipe between this machine");
      console.log("      and Tally works. No network or software blockers.\n");
      process.exit(0);
    });
  }
);

req.on("timeout", () => {
  req.destroy();
  fail("timed out waiting for Tally to respond.", [
    "Tally is open but the gateway is off (F1 > Settings > Connectivity).",
    "'TallyPrime acts as' is not set to Both/Server.",
  ]);
});

req.on("error", (err) => {
  fail(`${err.code || ""} ${err.message}`.trim() || "could not connect", [
    "Tally Prime is not open.",
    "The gateway/port is off or wrong (default is 9000).",
    "A firewall is blocking the port (when testing across machines).",
    "Wrong IP address for the Tally machine.",
  ]);
});

req.write(requestXml);
req.end();
