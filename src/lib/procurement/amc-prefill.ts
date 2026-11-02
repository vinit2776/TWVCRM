import { BILLING_CYCLE_LABELS, type ServicePoBillingCycle } from "@/lib/constants";
import { cyclesBetween } from "@/lib/procurement/amc-billing";
import { formatDate } from "@/lib/utils";
import type { ExtractedAmcProposal } from "@/lib/procurement/proposal-extraction";

/** What the wizard already holds. Prefill only ever fills what is still empty. */
export interface PrefillCurrent {
  serviceName: string;
  startDate: string;
  endDate: string;
  visitsCovered: string;
  unlimitedVisits: boolean;
  contactName: string;
  helpline: string;
  contactEmail: string;
  /** The first asset line. Prefill never touches more than one line. */
  firstLine: { assetId: string; perCycleCost: string; lineCount: number };
}

export interface PrefillUpdates {
  serviceName?: string;
  startDate?: string;
  endDate?: string;
  visitsCovered?: string;
  coverage?: "comprehensive" | "labour_only";
  contactName?: string;
  helpline?: string;
  contactEmail?: string;
  firstLine?: { billingCycle: ServicePoBillingCycle; perCycleCost: string };
}

export interface PrefillQuestion {
  id: "amount";
  prompt: string;
  options: Array<{ label: string; value: number }>;
}

export interface PrefillPlan {
  updates: PrefillUpdates;
  /** What was read, for the user to see, in plain words. */
  found: Array<{ label: string; value: string }>;
  questions: PrefillQuestion[];
  /** Things worth knowing that don't fill a field. */
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const blank = (s: string) => s.trim() === "";

/**
 * Turns what was read from a proposal into wizard updates, without overwriting anything the
 * user already typed. When the document shows more than one possible contract value it asks
 * instead of choosing; pass the user's answer as `chosenValue` to continue.
 */
export function planAmcPrefill(x: ExtractedAmcProposal, cur: PrefillCurrent, chosenValue?: number): PrefillPlan {
  const updates: PrefillUpdates = {};
  const found: PrefillPlan["found"] = [];
  const questions: PrefillQuestion[] = [];
  const notes: string[] = [];

  if (x.vendorName) found.push({ label: "Vendor", value: x.vendorName });
  if (blank(cur.serviceName) && x.vendorName) updates.serviceName = `AMC, ${x.vendorName}`;

  const datesOk = x.startDate && x.endDate && x.endDate > x.startDate;
  if (datesOk) {
    found.push({ label: "Contract period", value: `${formatDate(x.startDate!)} – ${formatDate(x.endDate!)}` });
    if (blank(cur.startDate) && blank(cur.endDate)) {
      updates.startDate = x.startDate!;
      updates.endDate = x.endDate!;
    }
  }

  if (x.visitsPerYear) {
    found.push({ label: "Preventive visits", value: `${x.visitsPerYear} a year` });
    if (!cur.unlimitedVisits && blank(cur.visitsCovered)) {
      // The field is the contract's total, so a multi-year contract covers that many years of visits.
      const months = datesOk ? cyclesBetween(x.startDate, x.endDate, "monthly") : null;
      const years = months && months > 12 ? Math.round(months / 12) : 1;
      updates.visitsCovered = String(x.visitsPerYear * years);
    }
  }

  if (x.coverage) {
    found.push({ label: "Covers", value: x.coverage === "labour_only" ? "Labour only (parts extra)" : "Parts and labour" });
    updates.coverage = x.coverage;
  }

  if (x.contactName || x.contactPhone) {
    found.push({ label: "Vendor contact", value: [x.contactName, x.contactPhone].filter(Boolean).join(" · ") });
    if (blank(cur.contactName) && x.contactName) updates.contactName = x.contactName;
    if (blank(cur.helpline) && x.contactPhone) updates.helpline = x.contactPhone;
    if (blank(cur.contactEmail) && x.contactEmail) updates.contactEmail = x.contactEmail;
  }

  if (x.billingFrequency) {
    found.push({ label: "Billing", value: `${BILLING_CYCLE_LABELS[x.billingFrequency] ?? x.billingFrequency}${x.billedInAdvance ? ", in advance" : ""}` });
  }
  if (x.gstPercent !== null) notes.push(`The vendor adds ${x.gstPercent}% GST on each invoice. Enter amounts before GST.`);

  // Contract value: ask when the document shows more than one possibility.
  const candidates = [...new Set([...(x.valueBeforeGst ? [x.valueBeforeGst] : []), ...x.amountCandidates])];
  let value: number | null = chosenValue ?? x.valueBeforeGst;
  if (chosenValue === undefined && candidates.length >= 2) {
    questions.push({
      id: "amount",
      prompt: "The proposal shows more than one amount. Which is the total contract value before GST?",
      options: candidates.map((c) => ({ label: inr(c), value: c })),
    });
    value = null;
  }
  if (value) found.push({ label: "Contract value (before GST)", value: inr(value) });

  if (x.equipment.length > 1) {
    notes.push(`This proposal covers ${x.equipment.length} units. Add one asset per unit on the Cost step and enter each unit's share.`);
  } else if (value && x.billingFrequency && cur.firstLine.lineCount === 1 && blank(cur.firstLine.perCycleCost)) {
    const cycles = datesOk ? cyclesBetween(x.startDate, x.endDate, x.billingFrequency) : null;
    if (cycles && cycles > 0) {
      const each = round2(value / cycles);
      if (Math.abs(each * cycles - value) <= 0.01) {
        updates.firstLine = { billingCycle: x.billingFrequency, perCycleCost: String(each) };
        notes.push(`${cycles} ${BILLING_CYCLE_LABELS[x.billingFrequency]?.toLowerCase() ?? ""} bill${cycles === 1 ? "" : "s"} of ${inr(each)} before GST make up ${inr(value)}.`);
      } else {
        notes.push(`${inr(value)} does not split evenly into ${cycles} bills. Enter the amount per bill yourself on the Cost step.`);
      }
    }
  } else if (value && !x.billingFrequency) {
    notes.push("The billing frequency was not clear. Choose it on the Cost step.");
  }

  if (x.equipment.length > 0) {
    found.push({
      label: x.equipment.length === 1 ? "Equipment" : "Equipment covered",
      value: x.equipment.map((e) => [e.capacity, e.description].filter(Boolean).join(" ")).join("; "),
    });
  }

  return { updates, found, questions, notes };
}
