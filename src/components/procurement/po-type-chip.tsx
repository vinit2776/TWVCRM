import { Package, ClipboardList, ShieldCheck } from "lucide-react";
import { PO_KIND_LABELS, PO_KIND_STYLES, type PoKind } from "@/lib/procurement/po-type";

const ICONS = { goods: Package, service: ClipboardList, amc: ShieldCheck } as const;

export function PoTypeChip({ kind }: { kind: PoKind }) {
  const Icon = ICONS[kind];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${PO_KIND_STYLES[kind].chip}`}>
      <Icon className="h-3 w-3" /> {PO_KIND_LABELS[kind]}
    </span>
  );
}
