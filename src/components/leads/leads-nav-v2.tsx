"use client";

import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { groupCount, type LeadsNav, type LeadsNavItem } from "@/lib/leads-nav";

const pill = (on: boolean) =>
  `inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
    on ? "bg-foreground text-background border-foreground" : "text-muted-foreground hover:bg-muted"
  }`;

const badge = (tone: string, n: number) => (
  <span className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${tone || "bg-muted-foreground/20 text-foreground"}`}>{n}</span>
);

/** The new Leads navigation: daily tabs, then Buckets and Reports menus. The page owns what each entry does. */
export function LeadsNavV2({ nav, onSelect }: { nav: LeadsNav; onSelect: (item: LeadsNavItem) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {nav.daily.map((t) => (
        <button key={t.key} onClick={() => onSelect(t)} className={pill(t.active)}>
          {t.label}
          {t.count > 0 && badge(t.tone, t.count)}
        </button>
      ))}
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
      {nav.menus.map((g) => {
        const current = g.items.find((i) => i.active);
        const total = groupCount(g);
        return (
          <DropdownMenu key={g.key}>
            <DropdownMenuTrigger className={pill(!!current)}>
              {current ? `${g.label} · ${current.label}` : g.label}
              {!current && total > 0 && badge("bg-muted-foreground/20 text-foreground", total)}
              <ChevronDown className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              {g.items.map((i) => (
                <DropdownMenuItem key={i.key} onSelect={() => onSelect(i)} className={`flex items-center justify-between gap-6 ${i.active ? "font-semibold" : ""}`}>
                  <span>{i.label}</span>
                  {i.count > 0 && badge(i.tone, i.count)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </div>
  );
}
