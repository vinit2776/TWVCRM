"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronLeft, Package, Wrench, CalendarClock, ReceiptText, ClipboardCheck, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/providers/current-user-provider";
import {
  ITEM_CATALOG_DEPARTMENTS,
  PROCUREMENT_DEPARTMENTS,
  PROCUREMENT_DEPARTMENT_LABELS,
  PROCUREMENT_DEPARTMENT_EXAMPLES,
} from "@/lib/constants";

// The wizard only chooses a destination — every route it opens already exists.
const newRequestHref = (department: string) => `/procurement/requests/new?department=${department}`;

// Remembered per browser so a repeat buyer can skip straight to the same kind of request.
const LAST_DEPARTMENT_KEY = "twv.procurement.lastRequestDepartment";

// Matches who can create a PO today (orders/new is admin/manager).
const PO_FROM_REQUEST_ROLES = ["admin", "manager"];

// One-off services and bills have no PO type of their own: they are ordered through an
// Administration or Maintenance request, the same route they already take. The examples
// below are the ones the department definitions already use.
const SERVICE_DEPARTMENTS = [
  { key: "administration", examples: "e.g. ISP bills, machine rent" },
  { key: "maintenance", examples: "e.g. pest control, repair visits" },
] as const;

interface Choice {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  outcome: string;
}

const CHOICES: Choice[] = [
  { key: "goods", icon: Package, title: "Goods", description: "Physical items: stock, supplies, equipment", outcome: "Becomes a Goods PO after approval" },
  { key: "service", icon: Wrench, title: "Service or recurring bill", description: "e.g. ISP bills, machine rent, pest control", outcome: "Ordered through a purchase order after approval" },
  { key: "amc", icon: CalendarClock, title: "AMC / annual contract", description: "Yearly maintenance of HVAC, UPS, DG, RO", outcome: "Becomes a Service PO with visit tracking" },
  { key: "reimbursement", icon: ReceiptText, title: "Work for a customer", description: "Reimbursement: billed back to a customer contract with markup", outcome: "Reimbursement request" },
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
  const [step, setStep] = useState<"intent" | "goods" | "service">("intent");
  const [lastDepartment, setLastDepartment] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LAST_DEPARTMENT_KEY);
      if (saved && (PROCUREMENT_DEPARTMENTS as readonly string[]).includes(saved)) setLastDepartment(saved);
    } catch {
      // Storage can be unavailable (private window, blocked site data) — the shortcut is optional.
    }
  }, []);

  function openRequest(department: string) {
    try {
      window.localStorage.setItem(LAST_DEPARTMENT_KEY, department);
    } catch {
      // Not remembering the choice is fine.
    }
    router.push(newRequestHref(department));
  }

  const canCreatePo = !!user?.role && PO_FROM_REQUEST_ROLES.includes(user.role);
  const choices = CHOICES.filter((c) => c.key !== "approved" || canCreatePo);

  function pick(key: string) {
    if (key === "goods") setStep("goods");
    else if (key === "service") setStep("service");
    else if (key === "amc") openRequest("amc");
    else if (key === "reimbursement") openRequest("reimbursement");
    else router.push("/procurement/requests?status=approved");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      {step === "service" ? (
        <>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setStep("intent")}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          <div>
            <h1 className="text-xl font-semibold">What kind of service?</h1>
            <p className="text-sm text-muted-foreground">This decides which budget the spend counts against.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {SERVICE_DEPARTMENTS.map((d) => (
              <OptionCard
                key={d.key}
                icon={Wrench}
                title={PROCUREMENT_DEPARTMENT_LABELS[d.key]}
                description={d.examples}
                onClick={() => openRequest(d.key)}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Maintenance of a specific asset on a yearly contract is an AMC, so pick that on the previous screen.
          </p>
        </>
      ) : step === "goods" ? (
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
                onClick={() => openRequest(d)}
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
          {lastDepartment && (
            <button
              type="button"
              onClick={() => openRequest(lastDepartment)}
              className="flex w-full items-center justify-between rounded-xl border border-dashed bg-muted/30 px-4 py-3 text-left text-sm transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>
                <span className="font-medium">Same as last time</span>
                <span className="text-muted-foreground"> · start a {PROCUREMENT_DEPARTMENT_LABELS[lastDepartment]} request</span>
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            </button>
          )}
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
