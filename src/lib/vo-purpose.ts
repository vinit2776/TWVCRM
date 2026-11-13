import type { VoPurpose } from "@/types";

/**
 * The five purposes that existed before migration 00684 added gst_new and
 * gst_existing. Postgres cannot drop enum values, so these stay valid forever
 * and existing cases keep them untouched.
 */
export type LegacyVoPurpose =
  | "gst_registration"
  | "mca_registration"
  | "branch_office"
  | "mail_handling"
  | "business_address";

export const NEW_GST_PURPOSES = ["gst_new", "gst_existing"] as const;

/** Legacy value -> new value, only where the meaning is unambiguous. */
const LEGACY_TO_NEW: Partial<Record<VoPurpose, VoPurpose>> = {
  gst_registration: "gst_new",
  branch_office: "gst_existing",
};

/** New value -> the legacy value whose checklists, letters and templates it reuses. */
const NEW_TO_LEGACY: Partial<Record<VoPurpose, LegacyVoPurpose>> = {
  gst_new: "gst_registration",
  gst_existing: "branch_office",
};

export function isNewGstPurpose(purpose: string | null | undefined): boolean {
  return purpose === "gst_new" || purpose === "gst_existing";
}

/** The current-vocabulary value for a purpose (legacy gst values map across; the rest are unchanged). */
export function toCurrentPurpose<T extends string>(purpose: T): T | VoPurpose {
  return LEGACY_TO_NEW[purpose as VoPurpose] ?? purpose;
}

/**
 * The legacy value that drives checklists, authority letters and agreement
 * templates. New values behave exactly like their closest legacy counterpart;
 * anything else (including unknown strings) passes through unchanged.
 */
export function legacyPurposeFor<T extends string>(purpose: T): T | LegacyVoPurpose {
  return NEW_TO_LEGACY[purpose as VoPurpose] ?? purpose;
}

/** Purposes that register or vary a GST place of business, so a GST place must be captured. */
export function purposeNeedsGstPlace(purpose: string | null | undefined): boolean {
  return (
    purpose === "gst_new" ||
    purpose === "gst_existing" ||
    purpose === "gst_registration" ||
    purpose === "branch_office"
  );
}

/** Principal place of business (new GST registration). */
export function isPrincipalGstPurpose(purpose: string | null | undefined): boolean {
  return purpose === "gst_new" || purpose === "gst_registration";
}

/** Additional place of business under an existing GSTIN. */
export function isAdditionalGstPurpose(purpose: string | null | undefined): boolean {
  return purpose === "gst_existing" || purpose === "branch_office";
}

/**
 * True when Postgres rejected a purpose because the enum value does not exist
 * yet (22P02 invalid_text_representation). Code deploys before migration 00684
 * is applied, so writes of gst_new / gst_existing must degrade to a clear
 * message instead of a 500.
 */
export function isMissingEnumValueError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "22P02";
}

export const PURPOSE_MIGRATION_PENDING_MESSAGE =
  "This purpose is not available yet: the database update that adds it (migration 00684) has not been applied. Choose another purpose or try again shortly.";
