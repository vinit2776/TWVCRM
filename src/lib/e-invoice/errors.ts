/**
 * NIC e-Invoice error codes — abridged dictionary of the most common ones we'll
 * encounter in production. Maps NIC's terse messages to human-friendly UI text
 * and a recommended action.
 *
 * Source: NIC e-Invoice API Developer Portal (sandbox docs), supplemented by
 * GSTN's published list of error codes.
 *
 * Pattern: codes are 4-digit numeric strings; we keep them as strings to
 * preserve any leading zero NIC may prefix.
 */

export type RecoveryAction =
  | "retry"             // Transient; safe to retry after backoff
  | "fix_data"          // Fix invoice data and resubmit
  | "manual_review"     // Operator must review (may need CN or fresh invoice)
  | "auth_refresh"      // Refresh auth token and retry
  | "blocked"           // Cannot proceed via API; out-of-band action needed
  | "duplicate";        // IRN already exists for this document — no-op

export interface NicErrorMeta {
  code: string;
  short: string;        // Concise human label
  detail: string;       // Operator-facing explanation
  action: RecoveryAction;
}

/**
 * NIC error catalogue. Uncovered codes default to {action: "manual_review"}.
 */
export const NIC_ERROR_CATALOGUE: Record<string, NicErrorMeta> = {
  // ── Authentication ───────────────────────────────────────────────────────
  "1001": { code: "1001", short: "Invalid Auth Token",       detail: "Auth token is invalid or expired", action: "auth_refresh" },
  "1002": { code: "1002", short: "Auth Token Expired",        detail: "Token has expired (6 hr limit). Refresh it.", action: "auth_refresh" },
  "1005": { code: "1005", short: "Invalid Login Credentials", detail: "Username/password rejected by IRP", action: "blocked" },
  "1006": { code: "1006", short: "Invalid Client ID/Secret",  detail: "Client credentials rejected", action: "blocked" },

  // ── Duplicate / Idempotency ──────────────────────────────────────────────
  "2150": { code: "2150", short: "Duplicate IRN",             detail: "IRN already generated for this document number in the same FY. Fetch the existing IRN.", action: "duplicate" },
  "2172": { code: "2172", short: "Duplicate Cancel Request",  detail: "IRN is already cancelled.", action: "duplicate" },

  // ── Validation: GSTIN ────────────────────────────────────────────────────
  "2227": { code: "2227", short: "Invalid Seller GSTIN",      detail: "Seller GSTIN is invalid or inactive", action: "blocked" },
  "2228": { code: "2228", short: "Invalid Buyer GSTIN",       detail: "Buyer GSTIN failed checksum or is inactive", action: "fix_data" },
  "2275": { code: "2275", short: "Buyer GSTIN cancelled",     detail: "Buyer's GSTIN has been cancelled — invoice them as B2C or refuse", action: "fix_data" },

  // ── Validation: Document ─────────────────────────────────────────────────
  "2150_INV": { code: "2150_INV", short: "Doc Number Reused", detail: "Document number already used in this FY for this GSTIN+doc-type", action: "fix_data" },
  "2189": { code: "2189", short: "Invalid Doc Date",          detail: "Document date is more than allowed days old", action: "fix_data" },
  "2193": { code: "2193", short: "Doc Date in Future",        detail: "Document date cannot be in the future", action: "fix_data" },
  "2233": { code: "2233", short: "Future Date for FY",        detail: "Document date does not match a current/valid FY", action: "fix_data" },

  // ── Validation: Math / totals ────────────────────────────────────────────
  "2211": { code: "2211", short: "Invalid Item Total",        detail: "Sum of (assessable + GST + cess + other charges) ≠ total item value", action: "fix_data" },
  "2212": { code: "2212", short: "Invalid Invoice Total",     detail: "Sum of items + round-off ≠ total invoice value", action: "fix_data" },
  "2213": { code: "2213", short: "Invalid CGST/SGST Math",    detail: "CGST + SGST amounts don't match assessable × rate", action: "fix_data" },

  // ── Validation: Tax routing ──────────────────────────────────────────────
  "2199": { code: "2199", short: "Wrong Tax Type",            detail: "IGST applied on intrastate supply (or CGST/SGST on interstate)", action: "fix_data" },
  "2244": { code: "2244", short: "Place of Supply Mismatch",  detail: "Place of supply state code is invalid", action: "fix_data" },

  // ── Validation: HSN / Product ────────────────────────────────────────────
  "2240": { code: "2240", short: "Invalid HSN Code",          detail: "HSN/SAC code does not exist in the master", action: "fix_data" },
  "2256": { code: "2256", short: "HSN Required",              detail: "HSN/SAC code is mandatory for AATO ≥ ₹5 cr", action: "fix_data" },

  // ── Cancellation rules ───────────────────────────────────────────────────
  "2270": { code: "2270", short: "Cancel Window Expired",     detail: "Cancellation window (24 hrs) has expired. Issue a Credit Note instead.", action: "blocked" },
  "2271": { code: "2271", short: "EWB Active — Cannot Cancel", detail: "Active e-way bill exists. Cancel the EWB first.", action: "blocked" },

  // ── Server / Rate limiting ───────────────────────────────────────────────
  "2197": { code: "2197", short: "IRP Server Busy",           detail: "IRP is temporarily overloaded. Retry after a short delay.", action: "retry" },
  "9999": { code: "9999", short: "Server Error",              detail: "Generic IRP server error. Retry once; escalate if persistent.", action: "retry" },
};

/** Look up an error code with a graceful default. */
export function lookupNicError(code: string | undefined | null, message?: string): NicErrorMeta {
  if (!code) {
    return {
      code: "UNKNOWN",
      short: "Unknown Error",
      detail: message || "IRP returned an error without a code",
      action: "manual_review",
    };
  }
  const known = NIC_ERROR_CATALOGUE[code];
  if (known) return known;
  return {
    code,
    short: `Error ${code}`,
    detail: message || "Uncatalogued IRP error — review the API log for details",
    action: "manual_review",
  };
}

/** Whether this error type warrants an automatic retry */
export function isRetryable(meta: NicErrorMeta): boolean {
  return meta.action === "retry" || meta.action === "auth_refresh";
}
