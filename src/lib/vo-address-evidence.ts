import { z } from "zod";
import type { AddressVerdict } from "@/lib/vo-address-watch";

/**
 * Manual evidence for the post-lapse address watch.
 *
 * Until a licensed GST/MCA lookup is bought, a person checks the public record
 * by hand and records what they found. The finding is the person's words; the
 * verdict stored on vo_address_checks (the value the pure rules read) is
 * derived from it here, in one place.
 */

export const ADDRESS_EVIDENCE_ROLES = ["admin", "manager", "accounts", "office_admin"];

export const ADDRESS_CHECK_SOURCES = ["gst_portal", "mca", "website", "reception", "manual"] as const;
export type AddressCheckSource = (typeof ADDRESS_CHECK_SOURCES)[number];

export const ADDRESS_CHECK_SOURCE_LABELS: Record<AddressCheckSource, string> = {
  gst_portal: "GST portal",
  mca: "MCA registered office",
  website: "Website or listing",
  reception: "Reception (mail or couriers)",
  manual: "Other",
};

export const ADDRESS_FINDINGS = ["found_using", "not_found", "deregistration_proof_received"] as const;
export type AddressFinding = (typeof ADDRESS_FINDINGS)[number];

export const ADDRESS_FINDING_LABELS: Record<AddressFinding, string> = {
  found_using: "Our address is still in use",
  not_found: "Our address was not found",
  deregistration_proof_received: "Customer sent deregistration proof",
};

/** Weak sources can only raise a flag; they never prove an address is clear. */
const STRONG_SOURCES: readonly AddressCheckSource[] = ["gst_portal", "mca"];

/**
 * found_using on a strong source is in_use; on a weak one it is only likely
 * (staff confirm before any invoice, per Mock 13). not_found is clear only
 * from a strong source, otherwise inconclusive. Proof is recorded as clear and
 * flagged in raw.finding so billing stops (see isProofRecorded).
 */
export function verdictForFinding(finding: AddressFinding, source: AddressCheckSource): AddressVerdict {
  const strong = STRONG_SOURCES.includes(source);
  if (finding === "found_using") return strong ? "in_use" : "likely";
  if (finding === "not_found") return strong ? "clear" : "inconclusive";
  return "clear";
}

export const addressCheckSchema = z.object({
  source: z.enum(ADDRESS_CHECK_SOURCES),
  finding: z.enum(ADDRESS_FINDINGS),
  checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-08-22"),
  note: z.string().trim().min(5, "Add a short note of what you saw").max(1000),
  evidence_ref: z.string().trim().max(500).optional(),
});
export type AddressCheckInput = z.infer<typeof addressCheckSchema>;

export const addressReleaseSchema = z.object({
  action: z.literal("release"),
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters").max(1000),
});

/** Whole days from the lapse date to the check date; never negative. */
export function dayOffsetFrom(lapseDate: string, checkDate: string): number {
  const ms = Date.parse(`${checkDate}T00:00:00Z`) - Date.parse(`${lapseDate.slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export interface StoredCheck {
  checked_at: string;
  verdict: AddressVerdict;
  raw?: unknown;
}

export function findingOf(check: { raw?: unknown }): AddressFinding | null {
  const raw = check.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const f = (raw as Record<string, unknown>).finding;
    if (typeof f === "string" && (ADDRESS_FINDINGS as readonly string[]).includes(f)) return f as AddressFinding;
  }
  return null;
}

/** A person recording the customer's proof is the verification; it stops billing. */
export function isProofRecorded(checks: { raw?: unknown }[]): boolean {
  return checks.some((c) => findingOf(c) === "deregistration_proof_received");
}

/** Postgres codes that mean "the migration has not been applied yet". */
export function isMissingSchema(err: { code?: string } | null | undefined): boolean {
  return !!err && (err.code === "42P01" || err.code === "42703" || err.code === "23514");
}
