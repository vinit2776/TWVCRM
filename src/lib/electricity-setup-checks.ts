/**
 * What has to be in place at a location before an electricity bill flows end to end.
 *
 * Each gap here otherwise fails quietly: no landlord vendor means saving a bill creates no payable in
 * Acc Payables; no contract switched on means no customer bill is made; a contract without a billing
 * profile cannot be billed. Pure so the rules are testable and the screen only draws the result.
 */

export interface SetupContract {
  contract_id: string;
  contract_number: string;
  /** contract_electricity_config.enabled */
  enabled: boolean;
  /** contracts.status */
  status: string;
  billing_profile_id: string | null;
  /** false when the profile exists but was switched off */
  profile_active: boolean;
}

export interface SetupInput {
  config: {
    enabled: boolean;
    landlord_vendor_id: string | null;
    landlord_utility_pct: number;
    landlord_generator_pct: number;
  } | null;
  landlordVendorName: string | null;
  activeConnections: number;
  contracts: SetupContract[];
  /** app_settings.electricity_auto_approve_enabled; a missing row means on */
  autoApproveEnabled: boolean;
}

export type SetupLevel = "required" | "recommended" | "info";

export interface SetupCheck {
  key: string;
  label: string;
  ok: boolean;
  level: SetupLevel;
  /** One sentence: what is set, or what goes wrong without it. */
  detail: string;
  /** Contracts to open to fix this check. */
  contracts?: { id: string; number: string }[];
}

// Same statuses the approve step uses to decide a contract can be billed.
const BILLABLE_STATUSES = ["active", "renewal_in_progress"];

export function computeSetupChecks(input: SetupInput): SetupCheck[] {
  const { config } = input;
  const checks: SetupCheck[] = [];

  checks.push({
    key: "enabled",
    label: "Electricity billing switched on for this location",
    ok: !!config?.enabled,
    level: "required",
    detail: config?.enabled
      ? "Landlord bills can be captured here."
      : "Landlord bills can't be captured until this is switched on above.",
  });

  const hasVendor = !!config?.landlord_vendor_id;
  checks.push({
    key: "landlord_vendor",
    label: "Landlord chosen",
    ok: hasVendor,
    level: "required",
    detail: hasVendor
      ? `${input.landlordVendorName ?? "Landlord"} gets the payable when a bill is saved.`
      : "Without a landlord, saving a bill creates no payable, so nothing reaches Acc Payables.",
  });

  const splitOk = !!config && Math.abs(config.landlord_utility_pct + config.landlord_generator_pct - 100) < 0.01;
  checks.push({
    key: "landlord_split",
    label: "Landlord split adds up to 100%",
    ok: splitOk,
    level: "required",
    detail: splitOk
      ? `${config!.landlord_utility_pct}% grid, ${config!.landlord_generator_pct}% generator.`
      : "Grid and generator shares must add up to 100%.",
  });

  const billable = input.contracts.filter((c) => c.enabled && BILLABLE_STATUSES.includes(c.status));
  checks.push({
    key: "contract_billed",
    label: "A contract is billed for electricity",
    ok: billable.length > 0,
    level: "required",
    detail: billable.length > 0
      ? `${billable.map((c) => c.contract_number).join(", ")} will be billed.`
      : "No active contract here has electricity billing switched on, so no customer bill will be made. Switch it on under Contract → Electricity Billing.",
    contracts: billable.length > 0 ? undefined : input.contracts.filter((c) => BILLABLE_STATUSES.includes(c.status)).map((c) => ({ id: c.contract_id, number: c.contract_number })),
  });

  if (billable.length > 0) {
    const noProfile = billable.filter((c) => !c.billing_profile_id || !c.profile_active);
    checks.push({
      key: "billing_profile",
      label: "Every billed contract has a billing profile",
      ok: noProfile.length === 0,
      level: "required",
      detail: noProfile.length === 0
        ? "Split and margin are set for each."
        : `${noProfile.map((c) => c.contract_number).join(", ")} ${noProfile.length === 1 ? "has" : "have"} no active billing profile, so ${noProfile.length === 1 ? "it" : "they"} can't be billed.`,
      contracts: noProfile.length === 0 ? undefined : noProfile.map((c) => ({ id: c.contract_id, number: c.contract_number })),
    });
  }

  checks.push({
    key: "connection",
    label: "Utility connection mapped",
    ok: input.activeConnections > 0,
    level: "recommended",
    detail: input.activeConnections > 0
      ? `${input.activeConnections} connection${input.activeConnections === 1 ? "" : "s"} mapped, so uploaded utility bills can be matched to this site.`
      : "Not needed for landlord bills. Needed to match uploaded utility bills to this site and compare with the meter.",
  });

  checks.push({
    key: "auto_approve",
    label: "Approve and confirm on capture",
    ok: input.autoApproveEnabled,
    level: "info",
    detail: input.autoApproveEnabled
      ? "A saved bill is approved and its customer bill confirmed automatically. Only Bill and Send is left."
      : "Switched off in settings: each bill needs Approve and Confirm by hand.",
  });

  return checks;
}

export function summariseSetup(checks: SetupCheck[]): { missingRequired: number; missingRecommended: number } {
  return {
    missingRequired: checks.filter((c) => c.level === "required" && !c.ok).length,
    missingRecommended: checks.filter((c) => c.level === "recommended" && !c.ok).length,
  };
}
