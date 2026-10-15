"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Home, Printer, Bolt, ShieldCheck, Repeat, Receipt, ChevronLeft,
  CalendarCheck, CalendarClock, Clock, Wrench, CircleHelp,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { useInvoiceWizardChecks, type CheckKey, type CheckTone } from "@/components/contracts/use-invoice-wizard-checks";
import { wizardChoices } from "@/lib/invoice-wizard-availability";
import { actionableRentRows, rentRowLabel } from "@/lib/invoice-wizard-checks";
import { cn, formatCurrency } from "@/lib/utils";
import {
  ADHOC_ATTRIBUTION_PURPOSE_LABELS,
  type AccountingHead,
  type AdhocAttributionPurpose,
} from "@/lib/constants";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  contractNumber: string;
  leadId: string;
  customerName?: string | null;
  locationId?: string | null;
  userRole: string | null;
  /** Display status (withdrawn counts separately from terminated). */
  contractStatus: string;
  depositShortfall?: number | null;
  /** Open the Add-on / Collect-deposit dialogs that live on the contract page. */
  onOpenAddon: () => void;
  onOpenDeposit: () => void;
}

const CHECK_TONE_CLASS: Record<CheckTone, string> = {
  ok: "text-green-700",
  warn: "text-amber-700",
  info: "text-muted-foreground",
};

type ChoiceKey = "rent" | "usage" | "electricity" | "deposit" | "addon" | "other";

interface Choice {
  key: ChoiceKey;
  icon: LucideIcon;
  title: string;
  description: string;
  outcome: string;
}

const CHOICES: Choice[] = [
  { key: "rent", icon: Home, title: "Rent", description: "Monthly rent, a missed month or a gap", outcome: "Opens the rent invoice for this contract" },
  { key: "usage", icon: Printer, title: "Usage", description: "Bookings, print and facility use", outcome: "Opens Add usage charge for this contract" },
  { key: "electricity", icon: Bolt, title: "Electricity", description: "Bill the customer's power cost", outcome: "Opens Capture Bill for this location" },
  { key: "deposit", icon: ShieldCheck, title: "Security deposit", description: "Collect more deposit", outcome: "Opens Collect Deposit for this contract" },
  { key: "addon", icon: Repeat, title: "Recurring extra", description: "Locker, parking, name board", outcome: "Opens Add recurring charge for this contract" },
  { key: "other", icon: Receipt, title: "Something else", description: "One-off: first invoice, late fee, damages", outcome: "Raises an invoice attached to this contract" },
];

// Who can attach an ad-hoc invoice to a contract (mirrors POST /api/invoices/[id]/attribution).
// Who may create one is decided in invoice-wizard-availability.ts.
const ATTRIBUTE_INVOICE_ROLES = ["admin", "accounts"];

interface OneOffPurpose {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  // Fixes the invoice's accounting head; omitted = the user chooses in the form.
  head?: AccountingHead;
  attribution: AdhocAttributionPurpose;
}

const ONE_OFF_PURPOSES: OneOffPurpose[] = [
  { key: "first", icon: CalendarCheck, title: "First invoice / pro-rata", description: "The partial first month. Once paid, it satisfies the activation gate.", head: "membership_fee", attribution: "prorata_first_invoice" },
  { key: "rent", icon: CalendarClock, title: "Rent outside the cycle", description: "Not sure? If a month was simply missed, use Rent instead.", head: "membership_fee", attribution: "monthly_rent" },
  { key: "late", icon: Clock, title: "Late fee", description: "Late payment charge, taxed at the usual rate", head: "late_fee", attribution: "other" },
  { key: "setup", icon: Wrench, title: "Setup fee or damages", description: "A taxable one-off", head: "setup_fee", attribution: "other" },
  { key: "other", icon: CircleHelp, title: "Other", description: "You'll pick the purpose in the form", attribution: "other" },
];

// The wizard only chooses a destination — every screen it opens already exists.
export function InvoiceCustomerWizard({
  open, onOpenChange, contractId, contractNumber, leadId, customerName, locationId, userRole, contractStatus, depositShortfall, onOpenAddon, onOpenDeposit,
}: Props) {
  const router = useRouter();
  const search = encodeURIComponent(contractNumber);
  const [step, setStep] = useState<"why" | "rent" | "other">("why");
  const [invoicePurpose, setInvoicePurpose] = useState<OneOffPurpose | null>(null);

  const { checks, loading: checksLoading, rentRows } = useInvoiceWizardChecks({ open: open && step === "why", contractId, depositShortfall });

  const allowed = wizardChoices(contractStatus, userRole);
  const choices = CHOICES.filter((c) => allowed.includes(c.key));
  const rentChoices = rentRows ? actionableRentRows(rentRows) : undefined;
  const rentNothingToOpen = !!checks.rent?.nothingToOpen;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) setStep("why");
  }

  // Scroll the section into view, then open its dialog.
  function openOnPage(id: string, open: () => void) {
    handleOpenChange(false);
    // Radix keeps the page scroll-locked until its close animation ends; scrolling
    // before then silently does nothing.
    setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      open();
    }, 350);
  }

  function pick(key: ChoiceKey) {
    if (key === "rent") {
      if (!rentChoices) router.push(`/billing?tab=rentals&search=${search}&open=1`); // rows not loaded: let the list decide
      else if (rentChoices.length === 0) router.push(`/billing?tab=rentals&search=${search}`);
      else if (rentChoices.length === 1) router.push(`/billing?tab=rentals&search=${search}&open=${encodeURIComponent(rentChoices[0].id ?? "1")}`);
      else setStep("rent");
    }
    else if (key === "usage") router.push(`/billing?tab=usage-charges&search=${search}&add_charge=${contractId}`);
    else if (key === "electricity") router.push(`/billing?tab=electricity&open=1${locationId ? `&location_id=${locationId}` : ""}`);
    else if (key === "deposit") openOnPage("section-deposit-topups", onOpenDeposit);
    else if (key === "addon") openOnPage("section-addons", onOpenAddon);
    else setStep("other");
  }

  function pickOneOff(p: OneOffPurpose) {
    setInvoicePurpose(p);
    handleOpenChange(false);
  }

  // Attaching ties the invoice to this contract's receivables, so it is only
  // done for roles the attribution API allows; others are told who finishes it.
  async function attachToContract(invoiceId: string) {
    const purpose = invoicePurpose?.attribution;
    if (!purpose) return;
    if (!userRole || !ATTRIBUTE_INVOICE_ROLES.includes(userRole)) {
      toast.info(
        `Invoice created. Ask admin or accounts to attach it to ${contractNumber} (Attributed invoices) as "${ADHOC_ATTRIBUTION_PURPOSE_LABELS[purpose]}".`,
        { duration: 10000 },
      );
      return;
    }
    const res = await fetch(`/api/invoices/${invoiceId}/attribution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract_id: contractId, purpose }),
    });
    if (res.ok) {
      toast.success(`Attached to ${contractNumber} as "${ADHOC_ATTRIBUTION_PURPOSE_LABELS[purpose]}"`);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || `Invoice created, but it couldn't be attached to ${contractNumber}. Attach it from Attributed invoices.`);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl">
          {step === "why" ? (
            <>
              <DialogHeader>
                <DialogTitle>Invoice wizard</DialogTitle>
                <DialogDescription>
                  {contractNumber} · Why are you invoicing {customerName || "this customer"}? Pick the closest and we open the right place for it.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {choices.map(({ key, icon: Icon, title, description, outcome }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => pick(key)}
                    className={cn(
                      "flex flex-col items-start justify-start rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      key === "rent" && rentNothingToOpen && "opacity-60",
                    )}
                  >
                    <Icon className="h-5 w-5 text-blue-600" aria-hidden />
                    <p className="mt-2 text-sm font-medium">{title}</p>
                    <p className="text-sm text-muted-foreground">{description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {key === "rent" && rentNothingToOpen ? "Shows this contract's rent queue" : outcome}
                    </p>
                    {key !== "other" && (() => {
                      const check = checks[key as CheckKey];
                      if (check) return <p className={cn("mt-1 text-xs font-medium", CHECK_TONE_CLASS[check.tone])}>{check.text}</p>;
                      return checksLoading ? <p className="mt-1 text-xs text-muted-foreground">Checking…</p> : null;
                    })()}
                  </button>
                ))}
              </div>
            </>
          ) : step === "rent" ? (
            <>
              <DialogHeader>
                <DialogTitle>Invoice wizard · Rent</DialogTitle>
                <DialogDescription>
                  {contractNumber} has {rentChoices?.length ?? 0} rent months waiting. Which one are you invoicing?
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                {(rentChoices ?? [])
                  .slice()
                  .sort((a, b) => (a.gapMonth ?? "9999").localeCompare(b.gapMonth ?? "9999"))
                  .map((r) => {
                    const amount = r.amount ?? r.estimate?.total ?? null;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => router.push(`/billing?tab=rentals&search=${search}&open=${encodeURIComponent(r.id ?? "1")}`)}
                        className="flex flex-col items-start justify-start rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <p className="text-sm font-medium">{rentRowLabel(r)}</p>
                        <p className="text-sm text-muted-foreground">
                          {r.category === "current_cycle" ? "Draft ready to review and send" : "Not invoiced yet"}
                        </p>
                        {amount != null && <p className="mt-1 text-xs text-muted-foreground">{r.category === "rent_gap" ? "About " : ""}{formatCurrency(amount)}</p>}
                      </button>
                    );
                  })}
              </div>
              <div>
                <Button variant="ghost" size="sm" onClick={() => setStep("why")}>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Invoice wizard · Something else</DialogTitle>
                <DialogDescription>
                  What is this charge for? We set the purpose for you, so it isn&apos;t picked from a list later.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ONE_OFF_PURPOSES.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => pickOneOff(p)}
                    className="flex flex-col items-start justify-start rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <p.icon className="h-5 w-5 text-blue-600" aria-hidden />
                    <p className="mt-2 text-sm font-medium">{p.title}</p>
                    <p className="text-sm text-muted-foreground">{p.description}</p>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openOnPage("section-deposit-topups", onOpenDeposit)}
                  className="flex flex-col items-start justify-start rounded-xl border border-dashed bg-card p-4 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ShieldCheck className="h-5 w-5 text-blue-600" aria-hidden />
                  <p className="mt-2 text-sm font-medium">Security deposit</p>
                  <p className="text-sm text-muted-foreground">Never invoiced here. Opens Deposit top-ups instead.</p>
                </button>
              </div>
              <div>
                <Button variant="ghost" size="sm" onClick={() => setStep("why")}>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <InvoiceForm
        leadId={leadId}
        open={!!invoicePurpose}
        onOpenChange={(next) => { if (!next) setInvoicePurpose(null); }}
        onSuccess={() => undefined}
        hasActiveProposal={false}
        onRequestProposal={() => router.push(`/leads/${leadId}`)}
        presetHead={invoicePurpose?.head}
        onCreated={(invoice) => attachToContract(invoice.id)}
      />
    </>
  );
}
