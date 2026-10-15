export type PoKind = "goods" | "service" | "amc";

/**
 * What a PO is, for display. AMC is judged by the contract, not the stored
 * po_type: a legacy AMC that was raised as a goods PO still reads as an AMC.
 */
export function poKind(po: {
  po_type?: string | null;
  amc_start_date?: string | null;
  purchase_requests?: { department?: string | null; expenditure_type?: string | null } | null;
}): PoKind {
  const pr = po.purchase_requests;
  if (pr?.expenditure_type === "amc" || pr?.department === "amc" || po.amc_start_date) return "amc";
  return po.po_type === "service" ? "service" : "goods";
}

export const PO_KIND_LABELS: Record<PoKind, string> = {
  goods: "Goods",
  service: "Service",
  amc: "AMC",
};

// Chosen to stay clear of the PO status palette (blue, purple, orange, green).
export const PO_KIND_STYLES: Record<PoKind, { chip: string; bar: string }> = {
  goods:   { chip: "bg-slate-100 text-slate-700",   bar: "bg-slate-400" },
  service: { chip: "bg-teal-100 text-teal-800",     bar: "bg-teal-500" },
  amc:     { chip: "bg-violet-100 text-violet-800", bar: "bg-violet-400" },
};
