"use client";

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/utils";
import {
  rentCheck, usageCheck, electricityCheck,
  type CheckKey, type WizardCheck, type RentRow, type UsageGroup, type ElecBill,
} from "@/lib/invoice-wizard-checks";

export type { CheckKey, CheckTone, WizardCheck } from "@/lib/invoice-wizard-checks";

interface Args {
  open: boolean;
  contractId: string;
  depositShortfall?: number | null;
}

async function getJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** Read-only, advisory hints for each Invoice wizard card. Never blocks a choice. */
export function useInvoiceWizardChecks({ open, contractId, depositShortfall }: Args) {
  const [checks, setChecks] = useState<Partial<Record<CheckKey, WizardCheck>>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const monthLabel = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
    setLoading(true);
    setChecks({});

    (async () => {
      const [rent, usage, elecCfg, elecBills, addons] = await Promise.allSettled([
        getJson("/api/billing/unbilled?type=rent", signal),
        getJson("/api/usage-billing/unbilled", signal),
        getJson(`/api/contracts/${contractId}/electricity-config`, signal),
        getJson(`/api/electricity-bills?contract_id=${contractId}&month=${month}&year=${year}`, signal),
        getJson(`/api/contracts/${contractId}/addons`, signal),
      ]);
      if (signal.aborted) return;

      const next: Partial<Record<CheckKey, WizardCheck>> = {};
      if (rent.status === "fulfilled") {
        next.rent = rentCheck(((rent.value.data ?? []) as RentRow[]).filter((r) => r.contractId === contractId));
      }
      if (usage.status === "fulfilled") {
        next.usage = usageCheck(((usage.value.data ?? []) as UsageGroup[]).find((g) => g.contractId === contractId));
      }
      if (elecCfg.status === "fulfilled") {
        const bills = elecBills.status === "fulfilled" ? ((elecBills.value.data ?? []) as ElecBill[]) : [];
        next.electricity = electricityCheck(!!elecCfg.value.data?.enabled, bills, monthLabel);
      }
      if (addons.status === "fulfilled") {
        const active = ((addons.value.data ?? []) as { is_active: boolean; amount: number }[]).filter((a) => a.is_active);
        next.addon = active.length > 0
          ? { tone: "info", text: `${active.length} active add-on${active.length === 1 ? "" : "s"}, ${formatCurrency(active.reduce((s, a) => s + Number(a.amount), 0))}/month` }
          : { tone: "info", text: "No recurring extras yet" };
      }
      if ((depositShortfall ?? 0) > 0) {
        next.deposit = { tone: "warn", text: `Renewal shortfall of ${formatCurrency(depositShortfall as number)} still to collect` };
      }
      setChecks(next);
      setLoading(false);
    })().catch(() => { if (!signal.aborted) setLoading(false); });

    return () => ctrl.abort();
  }, [open, contractId, depositShortfall]);

  return { checks, loading };
}
