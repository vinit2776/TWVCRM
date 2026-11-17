import { BILLING_CYCLE_LABELS, type ServicePoBillingCycle } from "@/lib/constants";
import { cyclesBetween } from "@/lib/procurement/amc-billing";
import { formatDate } from "@/lib/utils";
import type { ExtractedAmcProposal, ExtractedContact } from "@/lib/procurement/proposal-extraction";

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
  /** The asset lines as they stand. Units are only applied when this is still the one empty starter line. */
  firstLine: { assetId: string; perCycleCost: string; lineCount: number };
}

export interface PrefillLine {
  assetId: string;
  billingCycle: ServicePoBillingCycle;
  /** Pre-GST per bill; empty when the units on this line do not split into whole bills. */
  perCycleCost: string;
  /** The proposal's contract total for this line before GST: the agreed value may go below it, never above. */
  proposalTotal?: number;
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
  /** One-unit proposals: the starter line. */
  firstLine?: { billingCycle: ServicePoBillingCycle; perCycleCost?: string; proposalTotal?: number };
  /** Multi-unit proposals: one line per matched asset. */
  lines?: PrefillLine[];
}

export type PrefillQuestionId = "amount" | "frequency" | "coverage" | "contact";

export interface PrefillQuestion {
  id: PrefillQuestionId;
  prompt: string;
  options: Array<{ label: string; value: string }>;
}

/** The user's answers to the questions, by question id. */
export type PrefillAnswers = Partial<Record<PrefillQuestionId, string>>;

/** The unit is not ours or not covered by this contract: left out of the lines. */
export const UNIT_SKIPPED = "skip";

export interface PrefillPlan {
  updates: PrefillUpdates;
  /** What was read, for the user to see, in plain words. */
  found: Array<{ label: string; value: string }>;
  questions: PrefillQuestion[];
  /** Things worth knowing that don't fill a field. */
  notes: string[];
  /** Multi-unit proposals: how many units still need an asset (or "leave out") chosen. */
  unitsToDecide: number;
  /** Multi-unit proposals once every unit is decided: what this request covers of what the proposal lists. */
  unitScope?: { covered: number; leftOut: number; coveredTotal: number; proposalTotal: number | null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const blank = (s: string) => s.trim() === "";
const FREQUENCIES: ServicePoBillingCycle[] = ["monthly", "quarterly", "half_yearly", "yearly"];

/** The same person or number listed twice counts once: compared by the last 10 digits of the phone, else by name. */
const contactKey = (c: ExtractedContact) => {
  const digits = (c.phone ?? "").replace(/\D/g, "").slice(-10);
  return digits.length >= 6 ? digits : (c.name ?? "").toLowerCase().trim();
};

/** Every distinct vendor contact the proposal gives, the best one first. */
export function distinctContacts(x: ExtractedAmcProposal): ExtractedContact[] {
  const all: ExtractedContact[] = [];
  if (x.contactName || x.contactPhone) all.push({ name: x.contactName, phone: x.contactPhone, email: x.contactEmail, role: null });
  all.push(...x.contactCandidates);
  const seen = new Set<string>();
  return all.filter((c) => {
    const k = contactKey(c);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Turns what was read from a proposal into wizard updates, without overwriting anything the
 * user already typed. Anything the document leaves unclear, or shows more than one way, becomes
 * a question: nothing is guessed. `answers` holds the user's replies so far; `unitAssets` holds,
 * for each unit in the equipment table, the asset chosen for it ("" = undecided, UNIT_SKIPPED = leave out).
 */
export function planAmcPrefill(x: ExtractedAmcProposal, cur: PrefillCurrent, answers: PrefillAnswers = {}, unitAssets: string[] = []): PrefillPlan {
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
  } else {
    notes.push("The contract dates were not clear. Enter them on the Contract step.");
  }

  if (x.visitsPerYear) {
    found.push({ label: "Preventive visits", value: `${x.visitsPerYear} a year` });
    if (!cur.unlimitedVisits && blank(cur.visitsCovered)) {
      // The field is the contract's total, so a multi-year contract covers that many years of visits.
      const months = datesOk ? cyclesBetween(x.startDate, x.endDate, "monthly") : null;
      const years = months && months > 12 ? Math.round(months / 12) : 1;
      updates.visitsCovered = String(x.visitsPerYear * years);
    }
  } else {
    notes.push("The number of visits was not stated. Enter it on the Contract step.");
  }

  // Coverage decides who pays for parts, so it is never assumed.
  const coverage = x.coverage ?? (answers.coverage === "comprehensive" || answers.coverage === "labour_only" ? answers.coverage : null);
  if (coverage) {
    found.push({ label: "Covers", value: coverage === "labour_only" ? "Labour only (parts extra)" : "Parts and labour" });
    updates.coverage = coverage;
    if (x.coverage) notes.push("Check the proposal's exclusions: parts are covered only as its terms say.");
  } else {
    questions.push({
      id: "coverage",
      prompt: "The proposal does not say clearly who pays for spare parts. What does this contract cover?",
      options: [
        { label: "Parts and labour", value: "comprehensive" },
        { label: "Labour only (parts extra)", value: "labour_only" },
      ],
    });
  }

  // Several contacts means the user says who to call; one is used as read; none is a note.
  const contacts = distinctContacts(x);
  const picked = answers.contact !== undefined ? contacts[Number(answers.contact)] : contacts.length === 1 ? contacts[0] : undefined;
  if (contacts.length >= 2 && !picked) {
    questions.push({
      id: "contact",
      prompt: "The proposal gives more than one vendor contact. Who should be called when something breaks?",
      options: contacts.map((c, i) => ({ label: [c.name, c.phone, c.role].filter(Boolean).join(" · "), value: String(i) })),
    });
  } else if (picked) {
    found.push({ label: "Vendor contact", value: [picked.name, picked.phone].filter(Boolean).join(" · ") });
    if (blank(cur.contactName) && picked.name) updates.contactName = picked.name;
    if (blank(cur.helpline) && picked.phone) updates.helpline = picked.phone;
    if (blank(cur.contactEmail) && picked.email) updates.contactEmail = picked.email;
  } else {
    notes.push("No vendor contact was found. Enter one on the Contacts step.");
  }

  // Contract value: ask when the document shows more than one possibility.
  const candidates = [...new Set([...(x.valueBeforeGst ? [x.valueBeforeGst] : []), ...x.amountCandidates])];
  const chosen = answers.amount !== undefined ? Number(answers.amount) : undefined;
  let value: number | null = chosen ?? x.valueBeforeGst;
  if (chosen === undefined && candidates.length >= 2) {
    questions.push({
      id: "amount",
      prompt: "The proposal shows more than one amount. Which is the total contract value before GST?",
      options: candidates.map((c) => ({ label: inr(c), value: String(c) })),
    });
    value = null;
  }
  if (value) found.push({ label: "Contract value (before GST)", value: inr(value) });
  if (x.gstPercent !== null) notes.push(`The vendor adds ${x.gstPercent}% GST on each invoice. Enter amounts before GST.`);

  // How often the vendor bills decides the cost per bill, so it is asked when the document does not say.
  const frequency: ServicePoBillingCycle | null =
    x.billingFrequency ?? (FREQUENCIES.includes(answers.frequency as ServicePoBillingCycle) ? (answers.frequency as ServicePoBillingCycle) : null);
  if (x.billingFrequency) {
    found.push({ label: "Billing", value: `${BILLING_CYCLE_LABELS[x.billingFrequency] ?? x.billingFrequency}${x.billedInAdvance ? ", in advance" : ""}` });
  } else if (!frequency && (value || x.equipment.some((e) => e.rate))) {
    questions.push({
      id: "frequency",
      prompt: "The proposal does not say how often the vendor bills. How will they invoice?",
      options: FREQUENCIES.map((f) => ({ label: BILLING_CYCLE_LABELS[f] ?? f, value: f })),
    });
  } else if (!frequency) {
    notes.push("The billing frequency was not clear. Choose it on the Cost step.");
  }
  if (frequency && !x.billingFrequency) found.push({ label: "Billing (your answer)", value: BILLING_CYCLE_LABELS[frequency] ?? frequency });

  const cycles = datesOk && frequency ? cyclesBetween(x.startDate, x.endDate, frequency) : null;
  let unitsToDecide = 0;
  let unitScope: PrefillPlan["unitScope"];

  if (x.equipment.length > 1) {
    // One line per asset: units the user maps to the same asset are billed together.
    const decided = x.equipment.map((_, i) => unitAssets[i] ?? "");
    unitsToDecide = decided.filter((d) => d === "").length;
    const untouched = cur.firstLine.lineCount === 1 && blank(cur.firstLine.assetId) && blank(cur.firstLine.perCycleCost);
    if (unitsToDecide === 0 && frequency && untouched) {
      const byAsset = new Map<string, number[]>();
      decided.forEach((d, i) => { if (d !== UNIT_SKIPPED) byAsset.set(d, [...(byAsset.get(d) ?? []), i]); });
      const lines: PrefillLine[] = [];
      for (const [assetId, idx] of byAsset) {
        const rates = idx.map((i) => x.equipment[i].rate);
        let perCycleCost = "";
        if (rates.every((r): r is number => r !== null) && cycles && cycles > 0) {
          const annual = round2(rates.reduce((s, r) => s + r, 0));
          const each = round2(annual / cycles);
          if (Math.abs(each * cycles - annual) <= 0.01) perCycleCost = String(each);
          else notes.push(`${inr(annual)} for one asset does not split evenly into ${cycles} bills. Enter that amount per bill yourself on the Cost step.`);
        } else {
          notes.push("A unit had no cost in the proposal. Enter that asset's cost on the Cost step.");
        }
        const everyRate = rates.every((r): r is number => r !== null);
        lines.push({ assetId, billingCycle: frequency, perCycleCost, ...(everyRate ? { proposalTotal: round2(rates.reduce((sum, r) => sum + (r ?? 0), 0)) } : {}) });
      }
      if (lines.length > 0) updates.lines = lines;
      const left = decided.map((d, i) => (d === UNIT_SKIPPED ? i : -1)).filter((i) => i >= 0);
      if (left.length > 0) notes.push(`${left.length} unit${left.length === 1 ? " was" : "s were"} left out, as not covered by this contract.`);
      const unitSum = round2(x.equipment.reduce((s, e, i) => (decided[i] === UNIT_SKIPPED ? s : s + (e.rate ?? 0)), 0));
      unitScope = { covered: x.equipment.length - left.length, leftOut: left.length, coveredTotal: unitSum, proposalTotal: value };
      if (value && Math.abs(unitSum - value) > 1) notes.push(`The unit costs add up to ${inr(unitSum)}, but the proposal total is ${inr(value)}. Check the figures before sending.`);
    } else if (unitsToDecide === 0 && !untouched) {
      notes.push("You already entered asset lines, so the proposal's units were not applied. Check each line on the Cost step.");
    }
  } else if (value && frequency && cur.firstLine.lineCount === 1 && blank(cur.firstLine.perCycleCost)) {
    if (cycles && cycles > 0) {
      const each = round2(value / cycles);
      if (Math.abs(each * cycles - value) <= 0.01) {
        updates.firstLine = { billingCycle: frequency, perCycleCost: String(each), proposalTotal: value };
        notes.push(`${cycles} ${BILLING_CYCLE_LABELS[frequency]?.toLowerCase() ?? ""} bill${cycles === 1 ? "" : "s"} of ${inr(each)} before GST make up ${inr(value)}.`);
      } else {
        updates.firstLine = { billingCycle: frequency, proposalTotal: value };
        notes.push(`${inr(value)} does not split evenly into ${cycles} bills. Enter the amount per bill yourself on the Cost step.`);
      }
    }
  }

  if (x.equipment.length === 1) {
    const e = x.equipment[0];
    found.push({ label: "Equipment", value: [e.capacity, e.description].filter(Boolean).join(" ") });
  }

  return { updates, found, questions, notes, unitsToDecide, unitScope };
}

/** The asset whose serial number matches a unit's, when there is exactly one. */
export function suggestAssetForUnit(unit: { serial: string | null }, assets: Array<{ id: string; serial_number?: string | null }>): string {
  const key = unit.serial?.trim().toLowerCase();
  if (!key) return "";
  const hits = assets.filter((a) => a.serial_number?.trim().toLowerCase() === key);
  return hits.length === 1 ? hits[0].id : "";
}
