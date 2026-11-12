"use client";

import { useState } from "react";
import Link from "next/link";
import { Ban, ChevronRight, MoreHorizontal, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnquiryActions, NextStepLine, StageChip } from "@/components/enquiries/enquiry-actions";
import { EnquiryConversation } from "@/components/enquiries/enquiry-conversation";
import { EnquiryNameControl } from "@/components/enquiries/enquiry-name";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import type { ResolutionOutcome } from "@/providers/enquiry-notifications-provider";
import { ENQUIRY_SOURCE_LABEL, enquiryOutcomeLabel, enquiryStateLabel, type EnquiryItem } from "@/lib/enquiries";
import { rowPrimaryAction } from "@/lib/enquiry-row";
import { formatDate } from "@/lib/utils";

const OUTCOME_CLASS: Record<string, string> = {
  converted: "bg-emerald-100 text-emerald-800",
  not_interested: "bg-slate-100 text-slate-700",
  no_response: "bg-amber-100 text-amber-800",
  superseded: "bg-slate-50 text-slate-500 border border-dashed border-slate-300",
  spam: "bg-red-50 text-red-700 border border-dashed border-red-200",
};

const RESOLVE_OUTCOMES: { value: ResolutionOutcome; label: string; dot: string }[] = [
  { value: "converted", label: "Converted to lead", dot: "bg-emerald-500" },
  { value: "not_interested", label: "Not interested / no fit", dot: "bg-slate-400" },
  { value: "no_response", label: "Followed up, no response", dot: "bg-amber-500" },
];

/** One enquiry as a single line: who, what they said, one main button and a menu. Clicking the
 *  row opens the conversation and every action underneath. */
export function EnquiryLogRow({ row, readOnly, onChanged }: { row: EnquiryItem; readOnly: boolean; onChanged: () => void }) {
  const { claim, resolve } = useEnquiryNotifications();
  const [open, setOpen] = useState(false);
  const isSpam = row.resolutionOutcome === "spam";
  const primary = rowPrimaryAction({ resolvedAt: row.resolvedAt, isSpam, needsReview: !!row.needsReview, claimedAt: row.claimedAt });
  const canExpand = !readOnly;

  async function setSpam() {
    const res = await fetch(`/api/enquiries/${row.enquiryId}/spam`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spam: true }),
    });
    if (!res.ok) return toast.error((await res.json().catch(() => null))?.error ?? "Couldn't update the enquiry");
    toast.success("Marked as spam. It's in the Spam section.");
    onChanged();
  }

  async function runPrimary() {
    if (primary === "take") {
      await claim(row.enquiryId);
      onChanged();
    } else setOpen(true);
  }

  const status = row.resolutionOutcome ? (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${OUTCOME_CLASS[row.resolutionOutcome]}`}>
      {enquiryOutcomeLabel(row.resolutionOutcome)}
    </span>
  ) : (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${row.claimedAt ? "bg-blue-100 text-blue-800" : "bg-red-100 text-red-800"}`}
    >
      {row.resolvedAt ? "Resolved" : enquiryStateLabel(row)}
    </span>
  );

  return (
    <div className="border-t first:border-t-0">
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 hover:bg-muted/30 ${canExpand ? "cursor-pointer" : ""}`}
        onClick={() => canExpand && setOpen((v) => !v)}
        aria-expanded={canExpand ? open : undefined}
      >
        {canExpand && <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />}
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {readOnly ? (
              <span className="text-sm font-medium">{row.name}</span>
            ) : (
              <Link href={`/leads/${row.leadId}`} className="text-sm font-medium hover:underline">
                {row.name}
              </Link>
            )}
            {!readOnly && (
              <EnquiryNameControl
                enquiryId={row.enquiryId}
                name={row.name}
                placeholder={row.namePlaceholder}
                suggestedName={row.suggestedName}
                onChanged={onChanged}
              />
            )}
            {row.isReEnquiry && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Re-enquiry</span>
            )}
            {status}
            {!readOnly && row.stage && <StageChip stage={row.stage} />}
            {!readOnly && row.needsReview && !row.resolvedAt && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">Needs review</span>
            )}
          </div>
          {!readOnly && row.message && (
            <p className="truncate text-xs text-muted-foreground" title={row.message}>
              “{row.message}”
            </p>
          )}
        </div>
        <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(row.attentionResetAt)}</span>
        {!readOnly && (
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant={primary === "open" ? "outline" : "default"} onClick={runPrimary}>
              {primary === "review" && "Review"}
              {primary === "take" && (<><UserCheck className="mr-1 h-3.5 w-3.5" />I&apos;ll take this</>)}
              {primary === "log" && "Log update"}
              {primary === "open" && "Open"}
            </Button>
            {primary !== "open" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" aria-label="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => setOpen(true)}>Log update or history</DropdownMenuItem>
                  {RESOLVE_OUTCOMES.map((o) => (
                    <DropdownMenuItem
                      key={o.value}
                      onClick={async () => {
                        await resolve(row.enquiryId, o.value);
                        onChanged();
                      }}
                    >
                      <span className={`mr-2 inline-block h-2 w-2 rounded-full ${o.dot}`} />
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={setSpam}>
                    <Ban className="mr-2 h-3 w-3 text-red-600" />
                    Not an enquiry
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {open && canExpand && (
        <div className="grid gap-4 border-t bg-muted/20 px-4 py-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Conversation</p>
            <EnquiryConversation enquiryId={row.enquiryId} fallbackMessages={row.messages ?? []} fallbackDetails={row.details ?? []} />
          </div>
          <div className="space-y-2 text-xs">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Details</p>
            <p className="text-muted-foreground">
              <span className="font-mono">{row.reference}</span> · {ENQUIRY_SOURCE_LABEL[row.sourceTag] ?? row.source}
              <br />
              {row.mobile ? `+91 ${row.mobile}` : "No number"}
              {row.resolvedAt && (
                <>
                  <br />
                  Resolved {formatDate(row.resolvedAt)}
                  {row.resolutionOutcome !== "superseded" && row.resolverName ? ` by ${row.resolverName}` : ""}
                </>
              )}
            </p>
            <NextStepLine nextStep={row.nextStep} followUpAt={row.followUpAt} />
            <EnquiryActions
              enquiryId={row.enquiryId}
              claimedAt={row.claimedAt}
              claimerName={row.claimerName}
              resolvedAt={row.resolvedAt}
              isSpam={isSpam}
              needsReview={row.needsReview}
              nextStep={row.nextStep}
              followUpAt={row.followUpAt}
              onChanged={onChanged}
            />
          </div>
        </div>
      )}
    </div>
  );
}
