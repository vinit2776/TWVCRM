import { AlertTriangle } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { AmcConflict } from "@/lib/procurement/amc-overlap";

/** Warns, in plain words, that other AMCs already cover this asset in these dates. The user can carry on. */
export function AssetOverlapNote({ conflicts }: { conflicts: AmcConflict[] | undefined }) {
  if (!conflicts || conflicts.length === 0) return null;
  return (
    <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div className="space-y-0.5">
        <p className="font-medium">This asset is already covered by another AMC in these dates.</p>
        {conflicts.map((c) => (
          <p key={`${c.kind}-${c.id}`}>
            {c.kind === "po" ? "PO" : "Request"} {c.number}
            {c.vendor ? ` (${c.vendor})` : ""}: {formatDate(c.start)} to {formatDate(c.end)}
          </p>
        ))}
        <p>Carry on only if you mean to cover it twice, for example a different scope. Otherwise you may pay for it twice.</p>
      </div>
    </div>
  );
}

/** Warns that the chosen asset does not look like the unit the proposal lists. The user can keep it. */
export function AssetMismatchNote({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div className="space-y-0.5">
        <p className="font-medium">Check this is the right asset for this unit.</p>
        {reasons.map((r) => <p key={r}>Warning: {r}.</p>)}
      </div>
    </div>
  );
}
