/**
 * Reads the billing period an uploaded GST invoice says it covers, so it can be
 * checked against the statement's period. The invoice's own date is never
 * mistaken for a period: only date *ranges* ("01-Oct-2026 to 31-Oct-2026") and
 * "for <Month> <year>" phrases count.
 *
 * Returns calendar months as YYYY-MM. An empty list means the text names no
 * period we recognise — the caller must treat that as "unknown", not "mismatch".
 */
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// A single date as Tally or the CRM prints it: 01-Oct-2026, 1 Oct 2026, 1st October 2026, 01/10/2026.
const DATE = `(?:\\d{1,2}(?:st|nd|rd|th)?[-\\s/.]*(?:${MONTHS})[a-z]*[-\\s/.,]*\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4})`;
const RANGE = new RegExp(`(${DATE})\\s*(?:to|till|until|through|-|–|—)\\s*(${DATE})`, "gi");
const MONTH_PHRASE = new RegExp(
  `\\b(?:for|month\\s+of|period\\s+of|period)\\s*:?\\s*(?:the\\s+)?(?:month\\s+of\\s+)?(${MONTHS})[a-z]*[\\s,'-]+(\\d{4})\\b`,
  "gi",
);

function monthOfDate(s: string): string | null {
  const named = s.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[-\\s/.]*(${MONTHS})[a-z]*[-\\s/.,]*(\\d{4})`, "i"));
  if (named) return `${named[3]}-${String(MONTH_INDEX[named[2].slice(0, 3).toLowerCase()]).padStart(2, "0")}`;
  const numeric = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (numeric) {
    const month = Number(numeric[2]);
    if (month < 1 || month > 12) return null;
    return `${numeric[3]}-${String(month).padStart(2, "0")}`;
  }
  return null;
}

function monthsBetween(from: string, to: string): string[] {
  if (from > to) return [from];
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (y * 12 + m <= last && out.length < 24) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function extractInvoicePeriodMonths(text: string): string[] {
  const months = new Set<string>();

  for (const match of text.matchAll(RANGE)) {
    const from = monthOfDate(match[1]);
    const to = monthOfDate(match[2]);
    if (from && to) monthsBetween(from, to).forEach((m) => months.add(m));
  }
  for (const match of text.matchAll(MONTH_PHRASE)) {
    months.add(`${match[2]}-${String(MONTH_INDEX[match[1].slice(0, 3).toLowerCase()]).padStart(2, "0")}`);
  }
  return [...months].sort();
}

/**
 * True when the period the invoice names shares no month with the statement's
 * period — e.g. an invoice for 1–30 Nov uploaded against an 4–31 Oct statement.
 * Overlap, not equality: a pro-rata statement (Oct 4–31) legitimately sits
 * under an invoice that says "October 2026".
 */
export function invoicePeriodMismatch(
  invoiceMonths: string[] | null | undefined,
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): boolean {
  if (!invoiceMonths?.length || !periodStart || !periodEnd) return false;
  const statementMonths = monthsBetween(periodStart.slice(0, 7), periodEnd.slice(0, 7));
  return !invoiceMonths.some((m) => statementMonths.includes(m));
}
