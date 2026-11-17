import type { ExtractedAmcProposal } from "@/lib/procurement/proposal-extraction";
import { cyclesBetween } from "@/lib/procurement/amc-billing";
import { lineContractTotal } from "@/lib/procurement/proposal-cap";
import { formatCurrency, formatDate } from "@/lib/utils";

/** What an AMC request holds, as the compare needs it. */
export interface CompareRequest {
  startDate: string | null;
  endDate: string | null;
  visitsCovered: number | null;
  coverage: "comprehensive" | "labour_only" | null;
  openingCycles: number;
  lines: Array<{ quantity: number; perCycleCost: number | null; assetName: string | null; assetSerial: string | null }>;
}

export type CompareStatus = "match" | "differs" | "info" | "not_in_proposal";

export interface CompareRow {
  key: "period" | "visits" | "coverage" | "value" | "assets";
  label: string;
  status: CompareStatus;
  proposal: string;
  request: string;
  /** A line saying what to do about it; only on rows that differ. */
  hint?: string;
}

const COVERAGE_LABEL = { comprehensive: "Labour + parts", labour_only: "Labour only" } as const;
const VALUE_TOLERANCE = 1;

const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s\-_/]+/g, "").toLowerCase();

/**
 * Lays a vendor's proposal beside the AMC as it was set up. Advisory only: nothing here blocks or changes anything,
 * and a figure the proposal does not give is reported as not stated rather than as a difference.
 */
export function compareProposalToRequest(x: ExtractedAmcProposal, req: CompareRequest): CompareRow[] {
  const rows: CompareRow[] = [];

  // Period
  if (x.startDate && x.endDate) {
    const same = x.startDate === req.startDate && x.endDate === req.endDate;
    rows.push({
      key: "period", label: "Contract period", status: same ? "match" : "differs",
      proposal: `${formatDate(x.startDate)} – ${formatDate(x.endDate)}`,
      request: req.startDate && req.endDate ? `${formatDate(req.startDate)} – ${formatDate(req.endDate)}` : "Not set",
      hint: same ? undefined : "Check which dates were agreed. The contract's dates drive the billing cycles.",
    });
  } else {
    rows.push({ key: "period", label: "Contract period", status: "not_in_proposal", proposal: "Not stated", request: req.startDate && req.endDate ? `${formatDate(req.startDate)} – ${formatDate(req.endDate)}` : "Not set" });
  }

  // Visits: the request holds the contract total, the proposal a yearly figure.
  if (x.visitsPerYear) {
    const months = x.startDate && x.endDate ? cyclesBetween(x.startDate, x.endDate, "monthly") : null;
    const years = months && months > 12 ? Math.round(months / 12) : 1;
    const expected = x.visitsPerYear * years;
    const same = req.visitsCovered === expected;
    rows.push({
      key: "visits", label: "Preventive visits", status: same ? "match" : "differs",
      proposal: `${x.visitsPerYear} a year${years > 1 ? ` (${expected} over the contract)` : ""}`,
      request: req.visitsCovered != null ? `${req.visitsCovered} in total` : "Unlimited / not set",
      hint: same ? undefined : "The visit count is what the vendor is held to. Correct it if it was set wrongly.",
    });
  }

  // Coverage
  if (x.coverage) {
    const same = req.coverage === x.coverage;
    rows.push({
      key: "coverage", label: "What is covered", status: same ? "match" : "differs",
      proposal: COVERAGE_LABEL[x.coverage], request: req.coverage ? COVERAGE_LABEL[req.coverage] : "Not set",
      hint: same ? undefined : "Labour-only means parts are billed extra; make sure the request says the same as the vendor.",
    });
  }

  // Value, before GST, for the whole contract
  const requestTotal = Math.round(req.lines.reduce((s, l) => s + (l.perCycleCost != null ? lineContractTotal(l.quantity, req.openingCycles, l.perCycleCost) : 0), 0) * 100) / 100;
  if (x.valueBeforeGst != null) {
    const diff = requestTotal - x.valueBeforeGst;
    const status: CompareStatus = Math.abs(diff) <= VALUE_TOLERANCE ? "match" : diff < 0 ? "info" : "differs";
    rows.push({
      key: "value", label: "Contract value (before GST)", status,
      proposal: formatCurrency(x.valueBeforeGst), request: formatCurrency(requestTotal),
      hint: status === "differs" ? "The request is higher than the vendor's proposal. Ask for a corrected proposal, or fix the amount." : status === "info" ? "Lower than the proposal. Fine if this is the negotiated figure." : undefined,
    });
  } else {
    rows.push({ key: "value", label: "Contract value (before GST)", status: "not_in_proposal", proposal: "Not stated", request: formatCurrency(requestTotal) });
  }

  // Assets, matched on serial number
  if (x.equipment.length > 0) {
    const reqSerials = new Set(req.lines.map((l) => norm(l.assetSerial)).filter(Boolean));
    const withSerial = x.equipment.filter((e) => norm(e.serial));
    const missing = withSerial.filter((e) => !reqSerials.has(norm(e.serial)));
    const countDiffers = x.equipment.length !== req.lines.length;
    const ok = missing.length === 0 && !countDiffers;
    rows.push({
      key: "assets", label: "Assets covered", status: ok ? "match" : "differs",
      proposal: `${x.equipment.length} unit${x.equipment.length === 1 ? "" : "s"}${withSerial.length ? `, serials ${withSerial.map((e) => e.serial).join(", ")}` : ""}`,
      request: `${req.lines.length} asset${req.lines.length === 1 ? "" : "s"}${reqSerials.size ? `, serials ${[...req.lines.map((l) => l.assetSerial).filter(Boolean)].join(", ")}` : ""}`,
      hint: ok ? undefined : missing.length ? `Serial ${missing.map((e) => e.serial).join(", ")} in the proposal is not on this request's assets. Check the right asset is linked, and that its serial number is filled in on the asset.` : "The number of units differs. Check that every unit in the proposal is covered, or was deliberately left out.",
    });
  }

  return rows;
}
