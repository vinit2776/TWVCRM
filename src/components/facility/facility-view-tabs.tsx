"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Work orders | Complaints (n): the two views of Facility > Issues. */
export function FacilityViewTabs({ active, refreshKey = 0 }: { active: "work" | "complaints"; refreshKey?: number }) {
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/complaints?view=open")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setOpen(typeof j?.openCount === "number" ? j.openCount : null))
      .catch(() => {});
  }, [refreshKey]);

  const base = "rounded-full border px-3 py-1 text-xs font-medium";
  return (
    <div className="flex items-center gap-1">
      <Link
        href="/facility/issues"
        className={cn(base, active === "work" ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}
      >
        Work orders
      </Link>
      <Link
        href="/facility/issues?view=complaints"
        className={cn(base, active === "complaints" ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}
      >
        Complaints{open ? ` (${open})` : ""}
      </Link>
    </div>
  );
}
