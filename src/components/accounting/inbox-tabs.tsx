"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TallyInboxClient } from "@/components/accounting/tally-inbox-client";
import { DepositAccountingInbox } from "@/components/accounting/deposit-accounting-inbox";

interface Props {
  flagEnabled: boolean;
  currentUserRole: string;
}

type TopTab = "billing" | "deposits";

/**
 * Top-level tab switch for the Tally Inbox page. "Billing Handoff" is the
 * existing GST-invoice worklist, gated by tally_handoff_v2_enabled.
 * "Deposits" tracks security-deposit + top-up accounting and is
 * intentionally NOT gated by that flag — reconciling deposits against
 * Tally has nothing to do with the GST handoff flow.
 */
export function InboxTabs({ flagEnabled, currentUserRole }: Props) {
  const [tab, setTab] = useState<TopTab>("billing");
  const [depositOpenCount, setDepositOpenCount] = useState<number | null>(null);

  return (
    <div>
      <div className="flex items-center gap-2 mb-6 border-b">
        <button
          onClick={() => setTab("billing")}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "billing"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Billing Handoff
        </button>
        <button
          onClick={() => setTab("deposits")}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
            tab === "deposits"
              ? "border-violet-500 text-violet-700"
              : "border-transparent text-muted-foreground hover:text-violet-700"
          }`}
        >
          <Wallet className="h-3.5 w-3.5" />
          Deposits
          {depositOpenCount !== null && depositOpenCount > 0 && (
            <Badge className="bg-violet-100 text-violet-700 hover:bg-violet-100 h-5 px-1.5 text-[11px]">
              {depositOpenCount}
            </Badge>
          )}
        </button>
      </div>

      {tab === "billing" ? (
        !flagEnabled ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium mb-1">Tally handoff v2 is not enabled.</p>
            <p>
              An admin can enable it via Admin → Settings →{" "}
              <code className="font-mono text-xs bg-amber-100 px-1 py-0.5 rounded">
                tally_handoff_v2_enabled
              </code>
              . Until then this page is a placeholder.
            </p>
          </div>
        ) : (
          <TallyInboxClient />
        )
      ) : (
        <DepositAccountingInbox currentUserRole={currentUserRole} onOpenCountChange={setDepositOpenCount} />
      )}
    </div>
  );
}
