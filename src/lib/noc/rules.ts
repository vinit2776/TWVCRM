// Pure rules and wording for the NOC service (a paid No Objection Certificate that lets a customer's company use a
// TWV centre as its registered office or place of business). No I/O, so the API routes, the contract page and the
// unit tests share one definition. Plan: docs/plans/noc-service.md.

export const NOC_PURPOSES = ["roc", "gst"] as const;
export type NocPurpose = (typeof NOC_PURPOSES)[number];

/** The words printed in the certificate. A certificate names only its own purpose, never both. */
export const PURPOSE_LABELS: Record<NocPurpose, string> = { roc: "ROC Registration", gst: "GST Registration" };
export const PURPOSE_SHORT: Record<NocPurpose, string> = { roc: "ROC", gst: "GST" };

export const NOC_STATUSES = ["draft", "sent", "accepted", "paid", "issued", "void"] as const;
export type NocStatus = (typeof NOC_STATUSES)[number];

export const NOC_STATUS_LABELS: Record<NocStatus, string> = {
  draft: "Draft · not sent",
  sent: "Sent to customer",
  accepted: "Terms accepted",
  paid: "Paid · awaiting issue",
  issued: "Issued",
  void: "Void",
};

export const NOC_STATUS_COLORS: Record<NocStatus, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  sent: "bg-amber-100 text-amber-800 border-amber-200",
  accepted: "bg-amber-100 text-amber-800 border-amber-200",
  paid: "bg-indigo-100 text-indigo-800 border-indigo-200",
  issued: "bg-green-100 text-green-800 border-green-200",
  void: "bg-slate-100 text-slate-500 border-slate-200",
};

/** Contract statuses that can take a NOC. A NOC is a service on the customer, never a step toward activating. */
export const NOC_CONTRACT_STATUSES = ["sent", "viewed", "accepted", "active", "renewal_in_progress"] as const;
export const canOrderOnContract = (status: string) => (NOC_CONTRACT_STATUSES as readonly string[]).includes(status);

// ── Roles ────────────────────────────────────────────────────────────────────────────────────────────────────
export const canOrderNoc = (role: string | null | undefined) => ["admin", "manager", "sales_rep"].includes(role ?? "");
export const canVoidNoc = canOrderNoc;
/**
 * Stamp, seal and issue: admin only, the same as the stamp and seal already used on contracts and Virtual Office
 * agreements (the company signature and seal, with a unique stamp reference). The action itself arrives in a later
 * part; the rule lives here so the screen and the API cannot disagree.
 */
export const canIssueNoc = (role: string | null | undefined) => role === "admin";

/**
 * Why stamp-seal-issue cannot be used right now, in plain words, or null when it can. Payment must be recorded in
 * full (read from the payment itself by the caller, never a flag a person can set), and only an admin may do it.
 */
export function issueBlocker(role: string | null | undefined, status: NocStatus, paymentRecordedInFull: boolean): string | null {
  if (status === "issued") return "Already issued.";
  if (status === "void") return "This order is void.";
  if (!paymentRecordedInFull) return "Unlocks when the payment is recorded in full.";
  if (!canIssueNoc(role)) return "Only an admin can stamp, seal and issue.";
  return null;
}

/** A paid or issued order cannot be voided: a refund is a manual, accounts-led step. */
export const isVoidable = (status: NocStatus) => status === "draft" || status === "sent" || status === "accepted";

// ── Fee ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function computeFee(excludingGst: number, taxPercentage: number) {
  const tax = Math.round(excludingGst * taxPercentage) / 100;
  return { excludingGst, tax, total: Math.round((excludingGst + tax) * 100) / 100 };
}

// ── Reference, validity, marker ──────────────────────────────────────────────────────────────────────────────
export const nocReference = (contractNumber: string, sequenceInContract: number) => `${contractNumber}/NOC-${sequenceInContract}`;

/**
 * A NOC lasts as long as the contract it was ordered on: its validity IS the contract's end date, read live, so an
 * extension of the same contract lengthens it. A renewal is a new contract and starts with no NOC.
 */
export const nocValidUntil = (contractEndDate: string) => contractEndDate;
export const isNocExpired = (contractEndDate: string, todayYmd: string) => todayYmd > contractEndDate;

export interface NocBrief { status: NocStatus; purpose: NocPurpose; locationName?: string | null }
export interface NocMarker { tone: "issued" | "pending" | "expired"; text: string }

/**
 * The indicators shown on the contract page and the contracts list. An issued NOC always shows, including one
 * issued after the agreement started. A NOC that is ordered but not yet issued shows too (in a calmer tone), so
 * nobody assumes the customer already has it. Void orders show nothing.
 */
export function nocMarkers(nocs: NocBrief[], contractEndDate: string | null | undefined, todayYmd: string): NocMarker[] {
  const out: NocMarker[] = [];
  const expired = !!contractEndDate && isNocExpired(contractEndDate, todayYmd);
  for (const n of nocs) {
    if (n.status === "void") continue;
    const where = n.locationName ? ` · ${n.locationName}` : "";
    if (n.status === "issued") {
      out.push(expired
        ? { tone: "expired", text: `NOC expired · ${PURPOSE_SHORT[n.purpose]}${where}` }
        : { tone: "issued", text: `NOC issued · ${PURPOSE_SHORT[n.purpose]}${where}` });
    } else if (!expired) {
      out.push({ tone: "pending", text: `NOC ordered, not issued · ${PURPOSE_SHORT[n.purpose]}${where}` });
    }
  }
  return out;
}

// ── Order validation ─────────────────────────────────────────────────────────────────────────────────────────
export interface NocOrderInput {
  purpose?: string;
  locationId?: string;
  companyName?: string;
  cin?: string;
}

const CIN_RE = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;

export function validateOrder(p: NocOrderInput): string[] {
  const errors: string[] = [];
  if (!p.purpose || !(NOC_PURPOSES as readonly string[]).includes(p.purpose)) errors.push("Choose ROC registration or GST registration.");
  if (!p.locationId) errors.push("Choose the centre.");
  if (!p.companyName?.trim()) errors.push("Enter the company's name as it should appear on the NOC.");
  if (p.cin?.trim() && !CIN_RE.test(p.cin.trim().toUpperCase())) errors.push("The CIN does not look right (21 characters, for example U45400TN1987PTC014408).");
  return errors;
}

// ── The letter ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The three paragraphs of the certificate that the customer must accept on the link before paying. They are the
 * words of Vinit's approved NOC format, kept here as the single source: the PDF prints them and the customer page
 * shows exactly the same text. Do not reword without updating NOC_TEXT_VERSION.
 */
export const NOC_TEXT_VERSION = "NOC-T1";
export const NOC_CLAUSES: readonly string[] = [
  "The said Company is solely responsible for maintaining the books of accounts, signage space and other compliances and is allowed non-exclusive access to common open seating space. The authorized representative of the Company has assured us, they shall comply with all the statutory compliances arising out of the Companies Act, 2013 or under any other Act/ law.",
  "This NOC however does not confer any title in favor of this company, as being the owner of the property /premises. We shall bear no responsibility on their part for any acts/ deeds/ arrangements done by the Client with any other party whatsoever. Any defaults towards all statutory and /or other compliances under Indian law and/or the local regulations are the sole responsibility of the Client.",
  "The client clearly agrees to indemnify us for any/all claims made by the statutory or any other authorities arising as a result of such acts/deeds/arrangement of the client. The client further agrees that the use of address shall be discontinued by the client immediately pursuant to the expiry or termination of the agreement",
];

export interface NocLetterInput {
  purpose: NocPurpose;
  companyName: string;
  address: string;
  /** ISO dates (yyyy-mm-dd) */
  agreementDate: string | null;
  endDate: string;
  tenureMonths: number | null;
  signatoryName: string;
  signatoryDesignation: string;
  /** ISO date; omitted on a draft, which prints "[on issue]" */
  issueDate?: string | null;
}

/** dd.mm.yyyy as printed in the template. */
export const dotDate = (iso: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "[date]";
};

export interface NocLetter {
  addressee: string[];
  subject: string;
  intro: string;
  addressLine: string;
  agreementLine: string;
  consentLine: string;
  clauses: readonly string[];
  closing: string[];
  signature: { label: string; value: string }[];
}

/**
 * The certificate wording, one template for both purposes. Only the purpose phrase changes, and a certificate
 * never mentions the other purpose.
 */
export function buildNocLetter(i: NocLetterInput): NocLetter {
  const purpose = PURPOSE_LABELS[i.purpose];
  const company = i.companyName.trim();
  const months = i.tenureMonths ? `${i.tenureMonths} months` : "the agreed period";
  return {
    addressee: ["To", "The Registrar of Companies, (Tamilnadu)", "Dear Sir,"],
    subject: `Sub: No Objection Certificate / Letter of Consent for the use of address for ${purpose} for the business`,
    intro: `I, ${i.signatoryName}, ${i.signatoryDesignation} of Sree Design Infrastructure Pvt Ltd and we authorize to use address: -`,
    addressLine: `Address: ${i.address.trim()}`,
    agreementLine:
      `We have entered into an agreement on ${dotDate(i.agreementDate)} with ${company}, for the purpose of using the coworking space at above premises for the period of ${months} ending at ${dotDate(i.endDate)}. Address: ${i.address.trim()}`,
    consentLine: `I hereby confirm that we have “No Objection” and giving full consent for using the above address for ${purpose}, for ${company}.`,
    clauses: NOC_CLAUSES,
    closing: ["Thanking you,", "Yours faithfully"],
    signature: [
      { label: "Signature:", value: "" },
      { label: "Name of Owner:", value: i.signatoryName },
      { label: "Place:", value: "Chennai" },
      { label: "Date:", value: i.issueDate ? dotDate(i.issueDate) : "[on issue]" },
    ],
  };
}

/** The whole letter as plain text (tests, audit hashes, previews). */
export function nocLetterText(l: NocLetter): string {
  return [
    l.addressee.join("\n"), l.subject, `${l.intro}\n${l.addressLine}`, l.agreementLine, l.consentLine,
    ...l.clauses, l.closing.join("\n"),
    l.signature.map((s) => `${s.label} ${s.value}`.trim()).join("\n"),
  ].join("\n\n");
}
