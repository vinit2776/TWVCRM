"use client";

import { FileText, FileSignature, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  agreementLifecycleSubstate,
  invoiceLifecycleSubstate,
  LIFECYCLE_SUBSTATE_TEXT_COLORS,
} from "@/lib/constants";

interface CaseLifecycleIconsProps {
  proposalStatus?: string | null;
  agreementStatus?: string | null;
  billingStatus?: { payment_status?: string | null } | null;
  className?: string;
}

/**
 * Compact Proposal/Agreement/Invoice indicator for dense row contexts (e.g.
 * the Cases list table). Shares its tone/label mapping with the case detail
 * page's CaseStatusPipeline captions via src/lib/constants.ts, so the two
 * views never disagree about what a given substate means.
 */
export function CaseLifecycleIcons({
  proposalStatus,
  agreementStatus,
  billingStatus,
  className,
}: CaseLifecycleIconsProps) {
  const proposal = agreementLifecycleSubstate(proposalStatus);
  const agreement = agreementLifecycleSubstate(agreementStatus);
  const invoice = invoiceLifecycleSubstate(billingStatus);

  const items = [
    { Icon: FileText, label: "Proposal", substate: proposal },
    { Icon: FileSignature, label: "Agreement", substate: agreement },
    { Icon: Receipt, label: "Invoice", substate: invoice },
  ];

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {items.map(({ Icon, label, substate }) => (
        <span key={label} title={`${label}: ${substate.label}`}>
          <Icon className={cn("h-3.5 w-3.5", LIFECYCLE_SUBSTATE_TEXT_COLORS[substate.tone])} />
        </span>
      ))}
    </div>
  );
}
