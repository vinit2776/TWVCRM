/**
 * Renewal escalation for contract line items.
 *
 * A line escalates unless it is explicitly marked `escalates: false` (a fixed
 * component such as maintenance). Lines saved before the rent/maintenance
 * split existed carry no flag and keep escalating, so single-line contracts
 * behave exactly as before.
 */
export interface EscalatableLine {
  unit_price: number;
  escalates?: boolean;
}

export function lineEscalates(item: Pick<EscalatableLine, "escalates">): boolean {
  return item.escalates !== false;
}

export function escalateUnitPrice(
  item: EscalatableLine,
  multiplier: number,
  round: (n: number) => number = (n) => n
): number {
  return lineEscalates(item) ? round(item.unit_price * multiplier) : item.unit_price;
}
