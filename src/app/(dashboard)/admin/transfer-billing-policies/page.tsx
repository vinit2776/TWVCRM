"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Plus, Pencil, Loader2, Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

interface PolicyRow {
  id: string;
  location_id: string;
  is_billable: boolean;
  contract_id: string | null;
  service_charge_pct: number;
  notes: string | null;
  updated_at: string;
  location: { id: string; name: string };
  contract: { id: string; contract_number: string; status: string } | null;
}

interface Location {
  id: string;
  name: string;
}

interface Contract {
  id: string;
  contract_number: string;
  status: string;
  lead?: { company_name?: string; contact_name?: string };
}

export default function TransferBillingPoliciesPage() {
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // Form fields
  const [formLocationId, setFormLocationId] = useState("");
  const [formIsBillable, setFormIsBillable] = useState(false);
  const [formContractId, setFormContractId] = useState("");
  const [formServiceChargePct, setFormServiceChargePct] = useState("0");
  const [formNotes, setFormNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [polRes, locsRes, conRes] = await Promise.all([
        fetch("/api/admin/transfer-billing-policies").then((r) => r.json()),
        fetch("/api/locations").then((r) => r.json()),
        fetch("/api/contracts?status=active&limit=100").then((r) => r.json()).catch(() => ({ data: [] })),
      ]);
      setPolicies(polRes.data ?? []);
      setLocations(locsRes.data ?? locsRes.locations ?? []);
      setContracts(conRes.data ?? []);
    } catch {
      toast.error("Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openAdd = () => {
    setEditId(null);
    setFormLocationId("");
    setFormIsBillable(false);
    setFormContractId("");
    setFormServiceChargePct("0");
    setFormNotes("");
    setShowDialog(true);
  };

  const openEdit = (row: PolicyRow) => {
    setEditId(row.id);
    setFormLocationId(row.location_id);
    setFormIsBillable(row.is_billable);
    setFormContractId(row.contract_id ?? "");
    setFormServiceChargePct(String(row.service_charge_pct));
    setFormNotes(row.notes ?? "");
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (formIsBillable && !formContractId) {
      toast.error("Contract is required when billing is enabled");
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...(editId ? {} : { location_id: formLocationId }),
        is_billable: formIsBillable,
        contract_id: formContractId || null,
        service_charge_pct: parseFloat(formServiceChargePct) || 0,
        notes: formNotes || undefined,
      };

      const url = editId
        ? `/api/admin/transfer-billing-policies/${editId}`
        : "/api/admin/transfer-billing-policies";
      const method = editId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");

      toast.success(editId ? "Policy updated" : "Policy created");
      setShowDialog(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  // Example calculation for the info box
  const exampleBase = 1000;
  const exampleSvcPct = parseFloat(formServiceChargePct) || 0;
  const exampleSvc = exampleBase * exampleSvcPct / 100;
  const exampleSubtotal = exampleBase + exampleSvc;
  const exampleGst = exampleSubtotal * 0.18;
  const exampleTotal = exampleSubtotal + exampleGst;

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Transfer Billing Policies" }} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Transfer Billing Policies</h1>
          <p className="text-muted-foreground text-sm">
            Configure which destination locations are billed for incoming stock transfers.
          </p>
        </div>
        <Button onClick={openAdd} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Policy
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : policies.length === 0 ? (
        <div className="border rounded-lg p-12 text-center space-y-2">
          <p className="font-medium text-muted-foreground">No billing policies configured</p>
          <p className="text-sm text-muted-foreground">
            Add a policy to start billing a location for inbound stock transfers.
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Location</th>
                <th className="text-left p-3 font-medium">Billable</th>
                <th className="text-left p-3 font-medium">Contract</th>
                <th className="text-left p-3 font-medium">Service Charge</th>
                <th className="text-left p-3 font-medium">Notes</th>
                <th className="p-3 w-12" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {policies.map((row) => (
                <tr key={row.id} className="hover:bg-muted/20">
                  <td className="p-3 font-medium">{row.location.name}</td>
                  <td className="p-3">
                    <Badge variant={row.is_billable ? "default" : "secondary"}>
                      {row.is_billable ? "Billable" : "Not billable"}
                    </Badge>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {row.contract ? (
                      <span>
                        {row.contract.contract_number}
                        {row.contract.status !== "active" && (
                          <Badge variant="destructive" className="ml-2 text-xs">
                            {row.contract.status}
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-3">{row.service_charge_pct}%</td>
                  <td className="p-3 text-muted-foreground text-xs max-w-[200px] truncate">
                    {row.notes || "—"}
                  </td>
                  <td className="p-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEdit(row)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Policy" : "Add Billing Policy"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {!editId && (
              <div className="space-y-2">
                <Label>Location</Label>
                <Select value={formLocationId} onValueChange={setFormLocationId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select location..." />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between">
              <div>
                <Label>Enable Billing</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When on, all inbound transfers are auto-billed on receipt.
                </p>
              </div>
              <Switch
                checked={formIsBillable}
                onCheckedChange={setFormIsBillable}
              />
            </div>

            {formIsBillable && (
              <>
                <div className="space-y-2">
                  <Label>Linked Contract <span className="text-destructive">*</span></Label>
                  <Select value={formContractId} onValueChange={setFormContractId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select active contract..." />
                    </SelectTrigger>
                    <SelectContent>
                      {contracts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.contract_number}
                          {c.lead?.company_name && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              — {c.lead.company_name}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Service Charge %</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={formServiceChargePct}
                    onChange={(e) => setFormServiceChargePct(e.target.value)}
                    placeholder="e.g. 8"
                  />
                </div>

                {/* Calculation preview */}
                {exampleSvcPct > 0 && (
                  <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-1">
                    <div className="flex items-center gap-1 font-medium mb-2">
                      <Info className="h-3.5 w-3.5" />
                      Example: {formatCurrency(exampleBase)} procurement base
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Procurement value (incl. GST)</span>
                      <span>{formatCurrency(exampleBase)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Service charge ({exampleSvcPct}%)</span>
                      <span>{formatCurrency(exampleSvc)}</span>
                    </div>
                    <div className="flex justify-between font-medium border-t pt-1">
                      <span>Subtotal (billed pre-GST)</span>
                      <span>{formatCurrency(exampleSubtotal)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>+ GST 18% (from contract)</span>
                      <span>{formatCurrency(exampleGst)}</span>
                    </div>
                    <div className="flex justify-between font-semibold border-t pt-1">
                      <span>Total billed</span>
                      <span>{formatCurrency(exampleTotal)}</span>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="e.g. Capital Towers — Clix location, 8% service charge per agreement"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || (!editId && !formLocationId)}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editId ? "Save Changes" : "Create Policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
