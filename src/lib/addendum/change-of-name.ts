// Pure rules and wording for a "change of name" addendum (the same entity renamed, or a different entity taking over). No I/O, so the API
// routes, the contract page and the unit tests share one definition.

import { COMPANY_NAME, BRAND_NAME, COMPANY_ADDRESS } from "@/lib/pdf-utils";

export type AddendumStatus =
  | "draft" | "pending_approval" | "changes_requested" | "approved"
  | "signed" | "sealed" | "applied" | "withdrawn";

export const ADDENDUM_STATUS_LABELS: Record<AddendumStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  changes_requested: "Changes requested",
  approved: "Approved · out for signing",
  signed: "Customer signed",
  sealed: "Signed & sealed",
  applied: "Applied",
  withdrawn: "Withdrawn",
};

export const ADDENDUM_AUTHOR_ROLES = ["admin", "manager", "sales_rep"] as const;
export const ADDENDUM_APPROVER_ROLES = ["admin", "manager"] as const;
/** Stamping and applying touch TWV's seal and the customer record: admin only, as for the agreement stamp. */
export const ADDENDUM_SEAL_ROLES = ["admin"] as const;

const inRoles = (roles: readonly string[], role: string | null | undefined) => !!role && roles.includes(role);
export const canAuthorAddendum = (role: string | null | undefined) => inRoles(ADDENDUM_AUTHOR_ROLES, role);
export const canApproveAddendum = (role: string | null | undefined) => inRoles(ADDENDUM_APPROVER_ROLES, role);
export const canSealAddendum = (role: string | null | undefined) => inRoles(ADDENDUM_SEAL_ROLES, role);

/** The wording can be edited only before it is approved. */
export const isEditable = (status: string) => status === "draft" || status === "changes_requested";

/** same_entity: the Member is renamed. new_entity: a different legal person takes the agreement over. */
export type ChangeOfNameKind = "same_entity" | "new_entity";

export interface ChangeOfNameParams {
  kind: ChangeOfNameKind;
  newName: string;
  entityType: string;
  gstin: string;
  pan: string;
  cin: string;
  registeredAddress: string;
  signatoryName: string;
  signatoryDesignation: string;
  /** First day invoices are raised in the new name (YYYY-MM-DD). */
  effectiveDate: string;
  depositCarriesOver: boolean;
  /** true: the company takes over dues before the effective date. */
  companyTakesEarlierDues: boolean;
  /** Outgoing member, read from the lead. */
  outgoingName: string;
  outgoingAddress: string;
  /** Takeover only: is the outgoing party itself an entity (company, LLP, firm...) rather than an individual? */
  outgoingIsEntity?: boolean;
  outgoingSignatoryName?: string;
  outgoingSignatoryDesignation?: string;
  agreementDate: string;
  contractNumber: string;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

/** Blocking errors only: what the wording cannot be built without. */
export function validateParams(p: Partial<ChangeOfNameParams>): string[] {
  const errors: string[] = [];
  if (!p.newName?.trim()) errors.push("Enter the new legal name.");
  if (!p.effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveDate)) errors.push("Pick the date the change takes effect.");
  if (!p.signatoryName?.trim()) errors.push("Enter the authorised signatory's name.");
  if (p.kind === "new_entity" && p.outgoingIsEntity && !p.outgoingSignatoryName?.trim()) errors.push("Enter who signs for the outgoing entity.");
  if (p.gstin && !GSTIN_RE.test(p.gstin.trim().toUpperCase())) errors.push("The GSTIN does not look right (15 characters).");
  if (p.pan && !PAN_RE.test(p.pan.trim().toUpperCase())) errors.push("The PAN does not look right (for example ABCDE1234F).");
  return errors;
}

const longDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

const orBlank = (v: string | undefined | null, hint: string) => (v && v.trim() ? v.trim() : `[${hint}]`);

const idList = (p: ChangeOfNameParams) =>
  [p.cin?.trim() ? `CIN / registration no. ${p.cin.trim().toUpperCase()}` : "", p.pan?.trim() ? `PAN ${p.pan.trim().toUpperCase()}` : ""].filter(Boolean).join(", ");

const twvParty = `${COMPANY_NAME}, operating as ${BRAND_NAME}, of ${COMPANY_ADDRESS.join(" ")} ("TWV")`;

function agreementLine(p: ChangeOfNameParams, n: number) {
  return `This ADDENDUM NO. ${n} is made on [date of signing] to the Membership Agreement dated ${p.agreementDate ? longDate(p.agreementDate) : "[agreement date]"} (Contract ${p.contractNumber}) (the "Agreement") between:`;
}

const gstClause = (p: ChangeOfNameParams, who: string) =>
  `Invoices dated on or after the Effective Date will be raised in the name of ${who}${p.gstin?.trim() ? ` (GSTIN ${p.gstin.trim().toUpperCase()})` : ""}.`;

/** The same legal person under a new name: nothing is assigned, nothing is released. */
function sameEntityText(p: ChangeOfNameParams, n: number): string {
  const ids = idList(p);
  return [
    agreementLine(p, n), ``,
    `(1) ${twvParty}; and`,
    `(2) ${p.newName.trim()}${ids ? `, ${ids}` : ""}, of ${orBlank(p.registeredAddress, "address")}, formerly known as ${orBlank(p.outgoingName, "former name")}, represented by ${p.signatoryName.trim()}${p.signatoryDesignation?.trim() ? `, ${p.signatoryDesignation.trim()}` : ""} (the "Member").`,
    ``, `RECITALS`,
    `A. ${orBlank(p.outgoingName, "former name")} is the Member under the Agreement.`,
    `B. The Member has changed its name to ${p.newName.trim()}. It is the same legal person; only its name has changed.`,
    ``, `OPERATIVE TERMS`,
    `1. With effect from ${longDate(p.effectiveDate)} (the "Effective Date"), every reference in the Agreement to ${orBlank(p.outgoingName, "former name")} or to the "Member" means ${p.newName.trim()}.`,
    `2. The change of name does not affect any right or obligation under the Agreement. Amounts due, the security deposit and every other accrued right and liability continue as before.`,
    `3. The Agreement continues without a break. The term, seats, fees and all other commercial terms are unchanged.`,
    `4. ${gstClause(p, p.newName.trim())} Invoices raised before that date remain in the former name.`,
    `5. The Member confirms that the documents it has given TWV as proof of the change of name are true and complete.`,
    `6. All other terms of the Agreement are unchanged and remain in force.`,
  ].join("\n");
}

/** A different legal person takes the agreement over: an assignment, so the outgoing party signs too. */
function newEntityText(p: ChangeOfNameParams, n: number): string {
  const registered = ["pvt_ltd", "public_ltd", "llp", "trust", "society"].includes(p.entityType);
  const ids = idList(p);
  const outgoingParty = p.outgoingIsEntity
    ? `${orBlank(p.outgoingName, "outgoing member's name")}, of ${orBlank(p.outgoingAddress, "outgoing member's address")}, represented by ${orBlank(p.outgoingSignatoryName, "outgoing signatory")}${p.outgoingSignatoryDesignation?.trim() ? `, ${p.outgoingSignatoryDesignation.trim()}` : ""} (the "Outgoing Member")`
    : `${orBlank(p.outgoingName, "outgoing member's name")}, of ${orBlank(p.outgoingAddress, "outgoing member's address")} (the "Outgoing Member")`;
  const incoming =
    `${p.newName.trim()}${ids ? `, ${ids}` : ""}, having its ${registered ? "registered office" : "address"} at ` +
    `${orBlank(p.registeredAddress, "registered address")}, represented by ${p.signatoryName.trim()}` +
    `${p.signatoryDesignation?.trim() ? `, ${p.signatoryDesignation.trim()}` : ""} (the "Incoming Member")`;
  return [
    agreementLine(p, n), ``,
    `(1) ${twvParty};`,
    `(2) ${outgoingParty}; and`,
    `(3) ${incoming}.`,
    ``, `RECITALS`,
    `A. The Outgoing Member is the Member under the Agreement.`,
    p.outgoingIsEntity
      ? `B. The Outgoing Member has asked that the Agreement be taken over by the Incoming Member, and TWV has agreed, on the terms below.`
      : `B. The Outgoing Member has asked that the Agreement continue in the name of the Incoming Member, which will carry on the Outgoing Member's business, and TWV has agreed, on the terms below.`,
    ``, `OPERATIVE TERMS`,
    `1. With effect from ${longDate(p.effectiveDate)} (the "Effective Date"), the Incoming Member is the Member under the Agreement in place of the Outgoing Member, and every reference in the Agreement to the "Member" means the Incoming Member.`,
    `2. The Incoming Member takes on all rights and obligations of the Member under the Agreement from the Effective Date and agrees to be bound by the Agreement as if it had signed it originally.`,
    `3. The Agreement continues without a break. The term, seats, fees and all other commercial terms are unchanged.`,
    p.depositCarriesOver
      ? `4. The security deposit held under the Agreement is held for the Incoming Member and will be dealt with as the Agreement provides.`
      : `4. The security deposit held under the Agreement will be dealt with as TWV and the Members agree in writing separately.`,
    `5. ${gstClause(p, "the Incoming Member")} Invoices raised before that date remain in the name of the Outgoing Member.`,
    p.companyTakesEarlierDues
      ? `6. The Incoming Member takes over, and shall pay, all amounts due under the Agreement for the period before the Effective Date.`
      : `6. The Outgoing Member remains responsible for all amounts due under the Agreement for the period before the Effective Date.`,
    `7. The Incoming Member confirms that the documents it has given TWV about its identity and its authority to sign this Addendum are true and complete.`,
    `8. All other terms of the Agreement are unchanged and remain in force.`,
  ].join("\n");
}

/** The starting wording. Says only what the answers say; everything else stays with the agreement. */
export function buildChangeOfNameText(p: ChangeOfNameParams, addendumNumber: number): string {
  return p.kind === "same_entity" ? sameEntityText(p, addendumNumber) : newEntityText(p, addendumNumber);
}

export const KIND_LABELS: Record<ChangeOfNameKind, string> = {
  same_entity: "The same person or company, renamed",
  new_entity: "A different person or company takes over (for example an individual becoming a company)",
};

/** Names printed under the signature lines: two for a rename, three for a takeover. */
export function signatureBlocks(p: ChangeOfNameParams): { role: string; name: string }[] {
  const by = p.signatoryName ? `, by ${p.signatoryName}` : "";
  return p.kind === "same_entity"
    ? [{ role: "Member", name: `${p.newName}${by}` }, { role: "For TWV", name: COMPANY_NAME }]
    : [{ role: "Outgoing Member", name: p.outgoingIsEntity && p.outgoingSignatoryName ? `${p.outgoingName}, by ${p.outgoingSignatoryName}` : p.outgoingName }, { role: "Incoming Member", name: `${p.newName}${by}` }, { role: "For TWV", name: COMPANY_NAME }];
}

/**
 * Plain-words checks between the answer to "which case is this" and the IDs entered. A PAN identifies a
 * legal person, so a different PAN means a different person. Warns, never blocks.
 */
export function contextWarnings(kind: ChangeOfNameKind, newPan: string, currentPan: string | null | undefined, newEntityType: string, currentEntityType: string | null | undefined): string[] {
  const out: string[] = [];
  const np = newPan.trim().toUpperCase();
  const cp = (currentPan ?? "").trim().toUpperCase();
  if (kind === "same_entity" && np && cp && np !== cp) {
    out.push("The PAN you entered differs from the one on file. A different PAN means a different legal person, so this is probably a takeover. Choose \"A different person or company takes over\" or check the PAN.");
  }
  if (kind === "new_entity" && np && cp && np === cp) {
    out.push("This PAN matches the one already on file, so it looks like the same person renamed. Choose \"The same person or company, renamed\" if that is right.");
  }
  if (kind === "same_entity" && currentEntityType && newEntityType && currentEntityType !== newEntityType) {
    out.push("The entity type is changing (for example individual to company). That is a different legal person, not a rename.");
  }
  return out;
}

/** Square-bracket placeholders still to fill before submitting. */
export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\[[^\]\n]{2,60}\]/g) ?? [])];
}

/** Documents TWV should hold before the change is made (a warning, never a block). */
const DOC_CHECKLIST: Record<ChangeOfNameKind, readonly string[]> = {
  same_entity: [
    "Proof of the change of name (certificate of change of name, or fresh certificate of incorporation)",
    "PAN in the new name, if re-issued",
    "GST certificate showing the new name",
    "Authority letter or board resolution for the signatory",
    "Signatory's ID proof",
  ],
  new_entity: [
    "Certificate of incorporation or registration",
    "Company PAN",
    "GST registration certificate",
    "Board resolution or authority letter for the signatory",
    "Signatory's ID proof",
  ],
};

export function checklistFor(kind: ChangeOfNameKind, outgoingIsEntity?: boolean): readonly string[] {
  const base = DOC_CHECKLIST[kind];
  return kind === "new_entity" && outgoingIsEntity ? [...base, "Outgoing entity's board resolution or authority letter for its signatory"] : base;
}

/** What changes on the customer record when the addendum is applied. */
export function applyChanges(p: ChangeOfNameParams, lead: { company?: string | null; gst_number?: string | null; pan_number?: string | null; entity_type?: string | null }) {
  const next = {
    company: p.newName.trim(),
    gst_number: p.gstin?.trim() ? p.gstin.trim().toUpperCase() : (lead.gst_number ?? null),
    pan_number: p.pan?.trim() ? p.pan.trim().toUpperCase() : (lead.pan_number ?? null),
    entity_type: p.kind === "same_entity" ? (lead.entity_type ?? null) : (p.entityType || lead.entity_type || null),
  };
  const rows = (Object.keys(next) as (keyof typeof next)[]).map((k) => ({
    field: k,
    before: (lead[k] as string | null | undefined) ?? null,
    after: next[k],
  }));
  return { next, rows: rows.filter((r) => r.before !== r.after) };
}
