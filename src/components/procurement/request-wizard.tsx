"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Package, CalendarClock, ReceiptText, ClipboardCheck, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/providers/current-user-provider";
import {
  ITEM_CATALOG_DEPARTMENTS,
  PROCUREMENT_DEPARTMENT_LABELS,
  PROCUREMENT_DEPARTMENT_EXAMPLES,
} from "@/lib/constants";

// The wizard only chooses a destination — every route it opens already exists.
const newRequestHref = (department: string) => `/procurement/requests/new?department=${department}`;

// Matches who can create a PO today (orders/new is admin/manager).
const PO_FROM_REQUEST_ROLES = ["admin", "manager"];

interface Choice {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  outcome: string;
}

const CHOICES: Choice[] = [
  { key: "goods", icon: Package, title: "Goods", description: "Physical items: stock, supplies, equipment", outcome: "Becomes a Goods PO after approval" },
  { key: "amc", icon: CalendarClock, title: "AMC / annual contract", description: "Yearly maintenance of HVAC, UPS, DG, RO", outcome: "Becomes a Service PO with visit tracking" },
  { key: "reimbursement", icon: ReceiptText, title: "Work for a customer", description: "Billed back to a customer contract with markup", outcome: "Reimbursement request" },
  { key: "approved", icon: ClipboardCheck, title: "Create PO from approved request", description: "The request is already approved", outcome: "Opens your approved requests" },
];

function OptionCard({ icon: Icon, title, description, outcome, onClick }: {
  icon: LucideIcon; title: string; description: string; outcome?: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-5 w-5 text-blue-600" aria-hidden />
      <p className="mt-2 text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
      {outcome && <p className="mt-2 text-xs text-muted-foreground">{outcome}</p>}
    </button>
  );
}

export function RequestWizard() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const [step, setStep] = useState<"intent" | "goods">("intent");

  const canCreatePo = !!user?.role && PO_FROM_REQUEST_ROLES.includes(user.role);
  const choices = CHOICES.filter((c) => c.key !== "approved" || canCreatePo);

  function pick(key: string) {
    if (key === "goods") setStep("goods");
    else if (key === "amc") router.push(newRequestHref("amc"));
    else if (key === "reimbursement") router.push(newRequestHref("reimbursement"));
    else router.push("/procurement/requests?status=approved");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      {step === "goods" ? (
        <>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setStep("intent")}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          <div>
            <h1 className="text-xl font-semibold">What kind of goods?</h1>
            <p className="text-sm text-muted-foreground">This decides the budget and the items you can pick from.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {ITEM_CATALOG_DEPARTMENTS.map((d) => (
              <OptionCard
                key={d}
                icon={Package}
                title={PROCUREMENT_DEPARTMENT_LABELS[d]}
                description={PROCUREMENT_DEPARTMENT_EXAMPLES[d]}
                onClick={() => router.push(newRequestHref(d))}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => router.push("/procurement/requests")}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Requests
          </Button>
          <div>
            <h1 className="text-xl font-semibold">What do you want to buy?</h1>
            <p className="text-sm text-muted-foreground">Your answer sets up the right form for you.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {choices.map((c) => (
              <OptionCard key={c.key} icon={c.icon} title={c.title} description={c.description} outcome={c.outcome} onClick={() => pick(c.key)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
