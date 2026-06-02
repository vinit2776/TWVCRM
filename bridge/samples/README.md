# D5 Samples

Place real Tally XML responses here once captured. These unblock the full XML
builder implementation. See design doc §13 item 1 and TODOS.md.

Files to capture:
- `sales-voucher-request.xml`   — the XML you POST to Tally to create a sales voucher
- `sales-voucher-response.xml`  — Tally's full response (including IRN if sync)
- `einvoice-response.xml`       — E-invoice block if IRN comes in a separate response
- `error-response.xml`          — A LINEERROR or rejected-voucher response
- `credit-note-request.xml`     — XML for a credit note (CRN) voucher
- `current-company-response.xml`— Response to the current-company query

How to capture:
1. Open Tally Prime, load your company.
2. Use the connection tester (scripts/tally-connection-test/) to send queries.
3. For the sales voucher: create a test invoice in a test company.
4. Save the raw XML request and response for each.
