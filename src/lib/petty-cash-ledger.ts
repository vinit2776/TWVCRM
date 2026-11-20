// Plain-language labels and the balance check for the petty cash statement.

export type LedgerKind = "opening" | "issue" | "spend" | "vendor_payment" | "vendor_reversal" | "adjustment" | "return";

export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  opening: "Opening balance",
  issue: "Cash received from Accounts",
  spend: "Expense approved",
  vendor_payment: "Vendor bill paid in cash",
  vendor_reversal: "Vendor payment reversed",
  adjustment: "Other balance change",
  return: "Cash returned",
};

export const LEDGER_KIND_HELP: Record<LedgerKind, string> = {
  opening: "Where this statement started. Everything before it is not itemised.",
  issue: "Accounts handed over the cash you requested.",
  spend: "An expense of yours was approved and taken off the balance.",
  vendor_payment: "A vendor bill was paid in cash from this book.",
  vendor_reversal: "A vendor payment was undone, so the money came back.",
  adjustment: "The balance changed without going through a petty cash screen. Ask Accounts if you are unsure why.",
  return: "Cash was handed back.",
};

export interface Reconciliation {
  ledgerTotal: number;
  balance: number;
  matches: boolean;
  difference: number;
}

/** The statement is trustworthy only if its rows add up to the book's balance (to the paisa). */
export function reconcile(amounts: number[], balance: number): Reconciliation {
  const ledgerTotal = Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
  const difference = Math.round((balance - ledgerTotal) * 100) / 100;
  return { ledgerTotal, balance, matches: difference === 0, difference };
}
