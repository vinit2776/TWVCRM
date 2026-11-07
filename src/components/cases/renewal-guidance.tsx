"use client";

import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RENEWAL_GLOSSARY, type RenewalTerm } from "@/lib/vo-renewal-guidance";

/**
 * A renewal word with its short definition on hover. Keyboard focus shows it
 * too, so it is not mouse-only.
 */
export function RenewalTermHint({ term, children }: { term: RenewalTerm; children?: React.ReactNode }) {
  const entry = RENEWAL_GLOSSARY[term];
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
            {children ?? entry.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="font-medium">{entry.label}</p>
          <p>{entry.definition}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Why the button beside it is disabled, and how to fix it. Renders nothing
 * when there is nothing in the way.
 */
export function BlockerList({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <p className="mb-1 flex items-center gap-1 font-medium">
        <Info className="h-3.5 w-3.5" />
        Before you can continue
      </p>
      <ul className="list-disc space-y-0.5 pl-5">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}
