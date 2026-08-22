"use client";

import { ChevronRight, ArrowUpDown } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils";
import type { BreakdownMetric, CenterSummary } from "./types";

export type SortColumn = "sales" | "collections" | "billed" | "collection_efficiency_pct" | "occupancy_pct";

interface Props {
  centers: CenterSummary[];
  sortColumn: SortColumn;
  sortDir: "asc" | "desc";
  onSort: (col: SortColumn) => void;
  onSelectCenter: (locationId: string) => void;
  onSelectBreakdown: (locationId: string, metric: BreakdownMetric) => void;
}

function BreakdownCell({ amount, onClick }: { amount: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded text-left underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:decoration-primary hover:text-primary"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {formatCurrency(amount)}
    </button>
  );
}

const COLUMNS: Array<{ key: SortColumn; label: string }> = [
  { key: "sales", label: "Sales" },
  { key: "collections", label: "Collections" },
  { key: "billed", label: "Billed" },
  { key: "collection_efficiency_pct", label: "Coll. eff." },
  { key: "occupancy_pct", label: "Occupancy" },
];

export function ComparisonTable({ centers, sortColumn, sortDir, onSort, onSelectCenter, onSelectBreakdown }: Props) {
  const sorted = [...centers].sort((a, b) => {
    const diff = a[sortColumn] - b[sortColumn];
    return sortDir === "asc" ? diff : -diff;
  });

  if (sorted.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No centers match the current filters.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Center</TableHead>
            {COLUMNS.map((col) => (
              <TableHead
                key={col.key}
                className="cursor-pointer select-none whitespace-nowrap"
                onClick={() => onSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  <ArrowUpDown className={`h-3 w-3 ${sortColumn === col.key ? "text-foreground" : "text-muted-foreground/40"}`} />
                </span>
              </TableHead>
            ))}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((c) => (
            <TableRow
              key={c.location_id}
              role="button"
              tabIndex={0}
              className="cursor-pointer"
              onClick={() => onSelectCenter(c.location_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectCenter(c.location_id); }
              }}
            >
              <TableCell className="font-medium">{c.location_name}</TableCell>
              <TableCell>
                <BreakdownCell amount={c.sales} onClick={() => onSelectBreakdown(c.location_id, "sales")} />
              </TableCell>
              <TableCell>
                <BreakdownCell amount={c.collections} onClick={() => onSelectBreakdown(c.location_id, "collections")} />
              </TableCell>
              <TableCell>
                <BreakdownCell amount={c.billed} onClick={() => onSelectBreakdown(c.location_id, "billed")} />
              </TableCell>
              <TableCell>{c.collection_efficiency_pct}%</TableCell>
              <TableCell>
                {c.occupancy_pct}%{" "}
                <span className="text-xs text-muted-foreground">
                  ({c.occupied_seats}/{c.capacity})
                </span>
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                <ChevronRight className="ml-auto h-4 w-4" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
