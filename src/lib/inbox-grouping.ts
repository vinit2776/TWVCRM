/**
 * Grouping for the Tally Inbox list: by customer or by billing cycle.
 * Pure functions over the rows the inbox already loaded, so no extra queries.
 */
import type { InboxRow } from "@/lib/tally-handoff";
import { invoiceReasonFor } from "@/lib/invoice-reason";

export type InboxGroupBy = "action" | "customer" | "cycle" | "none";

export const INBOX_GROUP_BY_OPTIONS: { key: InboxGroupBy; label: string }[] = [
  { key: "action", label: "Action" },
  { key: "customer", label: "Customer" },
  { key: "cycle", label: "Cycle" },
  { key: "none", label: "None" },
];

/** "one_off" is the focus value for invoices that belong to no billing cycle. */
export const ONE_OFF_CYCLE = "one_off";

/**
 * The billing cycle an invoice belongs to, as YYYY-MM, or null when it has none.
 * Reimbursements and ad hoc invoices are dated by the day they were raised, so
 * their period_start is not a cycle.
 */
export function rowCycle(row: InboxRow): string | null {
  const key = invoiceReasonFor(row)?.key;
  if (key === "reimbursement" || key === "ad_hoc") return null;
  return row.period_start ? row.period_start.slice(0, 7) : null;
}

/** "NOV 2026" (short) or "November 2026". */
export function cycleLabel(cycle: string, short: boolean): string {
  const label = new Date(`${cycle}-01T00:00:00Z`).toLocaleDateString("en-IN", {
    month: short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return short ? label.toUpperCase() : label;
}

/**
 * True when the next move is accounts', false when the invoice is waiting on the
 * customer (sent, payment still due).
 */
export function needsAccounts(row: InboxRow): boolean {
  if (row.cancellation_requested_at || row.has_discrepancy) return true;
  return row.handoff_state !== "gst_sent_awaiting_payment" && row.handoff_state !== "pi_awaiting_payment";
}

export interface InboxRowGroup {
  key: string;
  kind: "customer" | "cycle";
  title: string;
  /** Customer GSTIN, shown beside the name. */
  subtitle: string | null;
  rows: InboxRow[];
  needs: number;
  total: number;
}

function leadOf(row: InboxRow) {
  return row.contract?.lead ?? row.proposal?.lead ?? row.invoice?.lead ?? null;
}

function build(
  kind: "customer" | "cycle",
  key: string,
  title: string,
  subtitle: string | null,
  rows: InboxRow[],
): InboxRowGroup {
  return {
    key,
    kind,
    title,
    subtitle,
    rows,
    needs: rows.filter(needsAccounts).length,
    total: rows.reduce((sum, r) => sum + Number(r.statement_total_amount || 0), 0),
  };
}

const byNeedsFirst = (a: InboxRow, b: InboxRow) => Number(needsAccounts(b)) - Number(needsAccounts(a));

/**
 * Customers that have something for accounts to do come first, then those that
 * are only waiting on the customer; alphabetical within each. Cycles run newest
 * first with the cycle-less one-offs last. Inside a group, what needs accounts
 * comes first; the incoming order breaks ties.
 */
export function groupInboxRows(
  rows: InboxRow[],
  by: "customer" | "cycle",
  partyName: (row: InboxRow) => string,
): InboxRowGroup[] {
  const map = new Map<string, InboxRow[]>();
  for (const row of rows) {
    const key = by === "customer" ? partyName(row).trim().toLowerCase() : rowCycle(row) ?? ONE_OFF_CYCLE;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }

  if (by === "customer") {
    return [...map.entries()]
      .map(([key, list]) => {
        const sorted = [...list].sort((a, b) => byNeedsFirst(a, b) || (rowCycle(b) ?? "").localeCompare(rowCycle(a) ?? ""));
        return build("customer", key, partyName(sorted[0]), leadOf(sorted[0])?.gst_number ?? null, sorted);
      })
      .sort((a, b) => Number(b.needs > 0) - Number(a.needs > 0) || a.title.localeCompare(b.title));
  }

  return [...map.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => byNeedsFirst(a, b) || partyName(a).localeCompare(partyName(b)));
      return build("cycle", key, key === ONE_OFF_CYCLE ? "No billing cycle · one-off" : cycleLabel(key, false), null, sorted);
    })
    .sort((a, b) => (a.key === ONE_OFF_CYCLE ? 1 : b.key === ONE_OFF_CYCLE ? -1 : b.key.localeCompare(a.key)));
}
