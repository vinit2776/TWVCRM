import { CONTRACT_QUOTA_LOCKED_STATUSES } from "@/lib/constants";

export interface DepositRequirementContract {
  status: string;
  security_deposit_amount?: number | string | null;
  security_deposit_months?: number | string | null;
  subtotal?: number | string | null;
  total_amount?: number | string | null;
}

/**
 * What one contract requires as security deposit, in rupees before GST.
 *
 * An activated contract's own snapshot wins (a negotiated deposit can differ
 * from months × rate). A renewal that carries its deposit forward snapshots
 * nothing, so it falls back to months × monthly fee — the same figure the
 * contract page shows — instead of reading as zero. Before activation the
 * linked proposal's figure applies.
 */
export function contractDepositRequirement(
  c: DepositRequirementContract,
  proposalAmount: number | null = null,
): number {
  const activated = (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(c.status);
  const snapshot = Number(c.security_deposit_amount || 0);
  if (!activated) return proposalAmount ?? snapshot;
  if (snapshot > 0) return snapshot;
  const months = Number(c.security_deposit_months || 0);
  if (months <= 0) return 0;
  return Math.round(months * Number(c.subtotal ?? c.total_amount ?? 0) * 100) / 100;
}

/** Shortfall is simply what is required, less what the customer's pool holds. */
export function depositShortfall(totalRequired: number, available: number): number {
  return Math.max(0, Math.round((totalRequired - available) * 100) / 100);
}
