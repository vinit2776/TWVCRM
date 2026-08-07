"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home } from "lucide-react";

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getTrail, resetTrail, seedTrail, type TrailEntry } from "@/lib/nav-trail";

const MAX_VISIBLE = 4;

type PageBreadcrumbProps =
  // Detail pages: reads the trail built by whichever page linked here, falling
  // back to a two-level "parent module > this page" crumb when there's no history.
  | { current: { label: string }; fallbackParent?: TrailEntry; resetTo?: never }
  // List/root pages: always start a fresh single-entry trail on mount.
  | { resetTo: { label: string }; current?: never; fallbackParent?: never };

export function PageBreadcrumb(props: PageBreadcrumbProps) {
  const pathname = usePathname();
  const [entries, setEntries] = useState<TrailEntry[] | null>(null);

  useEffect(() => {
    if (props.resetTo) {
      const entry: TrailEntry = { href: pathname, label: props.resetTo.label };
      resetTrail(entry);
      setEntries([entry]);
      return;
    }

    const trail = getTrail();
    const last = trail[trail.length - 1];

    if (last && last.href === pathname) {
      // Arrived via an in-app link that already registered this page — reuse the
      // trail, refreshing the leaf label in case the stored one drifted stale.
      const healed = [...trail.slice(0, -1), { href: pathname, label: props.current!.label }];
      seedTrail(healed);
      setEntries(healed);
      return;
    }

    // Direct link, bookmark, or a fresh tab — no path to read, fall back to a
    // fixed two-level crumb and self-heal storage so further navigation continues cleanly.
    const fallback: TrailEntry[] = props.fallbackParent
      ? [props.fallbackParent, { href: pathname, label: props.current!.label }]
      : [{ href: pathname, label: props.current!.label }];
    seedTrail(fallback);
    setEntries(fallback);
    // Only re-run when the route itself changes — current.label/fallbackParent are
    // read at effect time but aren't meant to retrigger the trail computation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (!entries || entries.length === 0) return null;

  const overflow = entries.length - MAX_VISIBLE;
  const collapsedEntries = overflow > 0 ? entries.slice(0, overflow + 1) : [];
  const visibleEntries = overflow > 0 ? entries.slice(overflow + 1) : entries;

  return (
    <Breadcrumb className="mb-3">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/dashboard" aria-label="Dashboard">
              <Home className="h-3.5 w-3.5" />
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {collapsedEntries.length > 0 && (
          <Fragment>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex items-center rounded hover:text-foreground"
                  aria-label="Show hidden breadcrumb items"
                >
                  <BreadcrumbEllipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {collapsedEntries.map((entry) => (
                    <DropdownMenuItem key={entry.href} asChild>
                      <Link href={entry.href}>{entry.label}</Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </Fragment>
        )}

        {visibleEntries.map((entry, idx) => {
          const isLast = idx === visibleEntries.length - 1;
          return (
            <Fragment key={entry.href}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{entry.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={entry.href}>{entry.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
