/**
 * Renewal-addendum wording for recurring add-ons: which ones continue, which are
 * new, which stop, and the two-section fee schedule (the escalating monthly fee,
 * then the add-ons that are never escalated). A renewal with no add-ons on either
 * side gets exactly the table it always had.
 */

export interface AddendumAddon {
  description: string;
  /** Monthly amount, excluding GST. */
  amount: number;
  effective_from: string;
  effective_until: string | null;
}

export interface AddonClassification {
  /** In both terms, at the same monthly amount. */
  continued: AddendumAddon[];
  /** Only in the renewal. */
  added: AddendumAddon[];
  /** Ran to the end of the old term and are not carried into the new one. */
  ended: AddendumAddon[];
}

const key = (a: Pick<AddendumAddon, "description">) => a.description.trim().toLowerCase();

export function classifyAddons(
  parentAddons: AddendumAddon[],
  renewalAddons: AddendumAddon[],
  parentEnd: string
): AddonClassification {
  const parentKeys = new Set(parentAddons.map(key));
  const renewalKeys = new Set(renewalAddons.map(key));
  return {
    continued: renewalAddons.filter((a) => parentKeys.has(key(a))),
    added: renewalAddons.filter((a) => !parentKeys.has(key(a))),
    // An add-on the customer had already stopped before the term ended is history, not news.
    ended: parentAddons.filter((a) => !renewalKeys.has(key(a)) && (!a.effective_until || a.effective_until >= parentEnd)),
  };
}

/** The addendum clause that says what happens to each add-on, or null when there is nothing to say. */
export function addonsClauseText(
  c: AddonClassification,
  parentEnd: string,
  formatMoney: (n: number) => string,
  formatDate: (ymd: string) => string,
  renewalEnd: string
): string | null {
  const describe = (a: AddendumAddon) =>
    `${a.description} (${formatMoney(a.amount)} + GST per month, ${formatDate(a.effective_from)} to ${formatDate(a.effective_until || renewalEnd)})`;
  const parts: string[] = [];
  if (c.continued.length > 0) {
    parts.push(`Continued at the same monthly amount, not escalated: ${c.continued.map(describe).join("; ")}.`);
  }
  if (c.added.length > 0) {
    parts.push(`Added for the renewal term, not subject to escalation: ${c.added.map(describe).join("; ")}.`);
  }
  if (c.ended.length > 0) {
    parts.push(`Not continued after ${formatDate(parentEnd)}: ${c.ended.map((a) => a.description).join(", ")}.`);
  }
  if (parts.length === 0) return null;
  return parts.join("\n") + "\nRecurring add-ons may be withdrawn on the Client's written request.";
}

export interface FeeCell {
  content: string;
  colSpan: number;
  styles: { fontStyle: "bold"; fillColor: [number, number, number] };
}
export type FeeRow = (string | FeeCell)[];

const SECTION_FILL: [number, number, number] = [238, 244, 243];
const round2 = (n: number) => Math.round(n * 100) / 100;

const section = (content: string): FeeRow => [{ content, colSpan: 5, styles: { fontStyle: "bold", fillColor: SECTION_FILL } }];

export interface FeeScheduleInput {
  items: { description: string; quantity: number; unit_price: number; total: number }[];
  subtotal: number;
  taxPercentage: number;
  /** Stored tax and total of the contract, used as they are when there are no add-ons. */
  taxAmount: number;
  totalAmount: number;
  addons: AddendumAddon[];
  renewalEnd: string;
  formatMoney: (n: number) => string;
  formatDate: (ymd: string) => string;
}

/**
 * The rows of "Schedule of Revised Fees". The last two (or three, with GST) rows
 * are always Subtotal, GST and Total, which the caller shows in bold.
 */
export function feeScheduleRows(input: FeeScheduleInput): FeeRow[] {
  const { items, addons, formatMoney, formatDate } = input;
  const itemRows: FeeRow[] = items.map((item, idx) => [
    String(idx + 1),
    item.description,
    String(item.quantity),
    formatMoney(item.unit_price),
    formatMoney(item.total),
  ]);

  if (addons.length === 0) {
    const rows: FeeRow[] = [...itemRows, ["", "", "", "Subtotal", formatMoney(input.subtotal)]];
    if (input.taxPercentage > 0) rows.push(["", "", "", `GST @ ${input.taxPercentage}%`, formatMoney(input.taxAmount)]);
    rows.push(["", "", "", "Total (incl. tax)", formatMoney(input.totalAmount)]);
    return rows;
  }

  const addonsTotal = round2(addons.reduce((sum, a) => sum + Number(a.amount), 0));
  const subtotal = round2(input.subtotal + addonsTotal);
  const tax = round2((subtotal * input.taxPercentage) / 100);
  const total = round2(subtotal + tax);

  const addonRows: FeeRow[] = addons.map((a, idx) => [
    String(items.length + idx + 1),
    `${a.description}\n${formatDate(a.effective_from)} to ${formatDate(a.effective_until || input.renewalEnd)}`,
    "1",
    formatMoney(a.amount),
    formatMoney(a.amount),
  ]);

  const rows: FeeRow[] = [
    section("Monthly membership fee (escalating)"),
    ...itemRows,
    section("Recurring add-ons (not escalated)"),
    ...addonRows,
    ["", "", "", "Subtotal", formatMoney(subtotal)],
  ];
  if (input.taxPercentage > 0) rows.push(["", "", "", `GST @ ${input.taxPercentage}%`, formatMoney(tax)]);
  rows.push(["", "", "", "Total (incl. tax)", formatMoney(total)]);
  return rows;
}
