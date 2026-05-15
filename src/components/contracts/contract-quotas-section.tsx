"use client";

/**
 * Service Quotas section on the contract detail page.
 *
 * Lets admin/manager/accounts set per-service monthly quotas + overage rates
 * (e.g. "B&W Print: 60 pages/month free, ₹5/page beyond"). The values are
 * stored on the contract and consumed when usage reports (printer reports,
 * future quota-based services) are uploaded — anything above quota becomes
 * a billable line item on the monthly statement.
 *
 * UX:
 *   - Each catalog service shows as a row.
 *   - If a quota row exists for the contract → values shown, "Edit" button
 *   - If no quota row exists → "Set quota" button creates one
 *   - Defaults pulled from service_catalog.default_overage_rate
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Loader2, Check, X, Info } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { ContractServiceQuota, ServiceCatalogItem } from "@/types";

interface Props {
  contractId: string;
  /** Locks the editor for non-active contracts (still renders, read-only). */
  readOnly?: boolean;
  /** Called after any successful save or remove, so the parent can refresh its quota count. */
  onSave?: () => void;
}

interface RowState {
  service: ServiceCatalogItem;
  quota: ContractServiceQuota | null;
  editing: boolean;
  draftQty: string;
  draftRate: string;
  saving: boolean;
}

export function ContractQuotasSection({ contractId, readOnly = false, onSave }: Props) {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    const [catalogRes, quotaRes] = await Promise.all([
      fetch("/api/service-catalog").then((r) => r.json()),
      fetch(`/api/contracts/${contractId}/quotas`).then((r) => r.json()),
    ]);
    const catalog = (catalogRes.data || []) as ServiceCatalogItem[];
    const quotas = (quotaRes.data || []) as ContractServiceQuota[];
    setRows(
      catalog.map((service) => ({
        service,
        quota: quotas.find((q) => q.service_id === service.id) ?? null,
        editing: false,
        draftQty: "",
        draftRate: "",
        saving: false,
      }))
    );
    setLoading(false);
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [contractId]);

  const startEdit = (idx: number) => {
    setRows((prev) => prev.map((r, i) =>
      i === idx ? {
        ...r,
        editing: true,
        draftQty: String(r.quota?.monthly_quota ?? 0),
        draftRate: String(r.quota?.overage_rate ?? r.service.default_overage_rate),
      } : r
    ));
  };

  const cancelEdit = (idx: number) => {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, editing: false } : r));
  };

  const save = async (idx: number) => {
    const row = rows[idx];
    const qty = Number(row.draftQty);
    const rate = Number(row.draftRate);
    if (!isFinite(qty) || qty < 0) { toast.error("Quota must be a non-negative number"); return; }
    if (!isFinite(rate) || rate < 0) { toast.error("Rate must be a non-negative number"); return; }

    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: true } : r));
    try {
      const res = await fetch(`/api/contracts/${contractId}/quotas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: row.service.id,
          monthly_quota: qty,
          overage_rate: rate,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success(`${row.service.name} quota saved`);
      await reload();
      onSave?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
      setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: false } : r));
    }
  };

  const remove = async (idx: number) => {
    const row = rows[idx];
    if (!row.quota) return;
    if (!confirm(`Remove ${row.service.name} quota? Future usage will not be billed.`)) return;

    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: true } : r));
    try {
      const res = await fetch(`/api/contracts/${contractId}/quotas?quota_id=${row.quota.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || "Failed to remove");
      }
      toast.success(`${row.service.name} quota removed`);
      await reload();
      onSave?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
      setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: false } : r));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>Service Quotas</span>
          <span className="text-xs font-normal text-muted-foreground">
            Free units/month · resets 1st of each month
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No services configured. Add services in Admin → Service Catalog first.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r, i) => {
              const hasQuota = !!r.quota;
              return (
                <div
                  key={r.service.id}
                  className="border rounded-lg p-3 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{r.service.name}</span>
                      <Badge variant="outline" className="text-[10px]">{r.service.unit_label}</Badge>
                    </div>
                    {!r.editing && hasQuota && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        <span className="font-medium text-foreground">{Number(r.quota!.monthly_quota)}</span> {r.service.unit_label} free; then {formatCurrency(Number(r.quota!.overage_rate))} {r.service.unit_label}
                      </div>
                    )}
                    {!r.editing && !hasQuota && (
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                        <Info className="h-3 w-3" />
                        No quota set — usage at default {formatCurrency(Number(r.service.default_overage_rate))} {r.service.unit_label}, every unit charged
                      </div>
                    )}
                    {r.editing && (
                      <div className="grid grid-cols-2 gap-2 mt-2 max-w-md">
                        <div>
                          <Label className="text-[10px]">Free quota / month</Label>
                          <Input
                            type="number" min="0" step="1"
                            value={r.draftQty}
                            onChange={(e) => setRows((prev) => prev.map((row, idx) => idx === i ? { ...row, draftQty: e.target.value } : row))}
                            className="mt-1 h-8"
                            disabled={r.saving}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Overage rate ({r.service.unit_label})</Label>
                          <Input
                            type="number" min="0" step="0.01"
                            value={r.draftRate}
                            onChange={(e) => setRows((prev) => prev.map((row, idx) => idx === i ? { ...row, draftRate: e.target.value } : row))}
                            className="mt-1 h-8"
                            disabled={r.saving}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {!readOnly && (
                    <div className="flex items-center gap-1 shrink-0">
                      {r.editing ? (
                        <>
                          <Button size="sm" onClick={() => save(i)} disabled={r.saving} className="h-7">
                            {r.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => cancelEdit(i)} disabled={r.saving} className="h-7">
                            <X className="h-3 w-3" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant={hasQuota ? "ghost" : "outline"} onClick={() => startEdit(i)} className="h-7">
                            <Pencil className="h-3 w-3 mr-1" />{hasQuota ? "Edit" : "Set quota"}
                          </Button>
                          {hasQuota && (
                            <Button size="sm" variant="ghost" onClick={() => remove(i)} disabled={r.saving} className="h-7">
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
