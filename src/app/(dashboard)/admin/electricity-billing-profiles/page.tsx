"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Pencil, Loader2, Power } from "lucide-react";

interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  customer_utility_pct: number;
  customer_generator_pct: number;
  utility_markup_type: "per_unit" | "percent";
  utility_markup_value: number;
  generator_markup_type: "per_unit" | "percent";
  generator_markup_value: number;
  customer_gst_rate: number;
  is_active: boolean;
}

export default function ElectricityBillingProfilesPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formUtilityPct, setFormUtilityPct] = useState("80");
  const [formGeneratorPct, setFormGeneratorPct] = useState("20");
  const [formUtilityMarkupType, setFormUtilityMarkupType] = useState<"per_unit" | "percent">("per_unit");
  const [formUtilityMarkupValue, setFormUtilityMarkupValue] = useState("0");
  const [formGeneratorMarkupType, setFormGeneratorMarkupType] = useState<"per_unit" | "percent">("per_unit");
  const [formGeneratorMarkupValue, setFormGeneratorMarkupValue] = useState("0");
  const [formGstRate, setFormGstRate] = useState("18");

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/electricity-billing-profiles").then((r) => r.json());
      setProfiles(res.data ?? []);
    } catch {
      toast.error("Failed to load profiles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openAdd = () => {
    setEditId(null);
    setFormName("");
    setFormDescription("");
    setFormUtilityPct("80");
    setFormGeneratorPct("20");
    setFormUtilityMarkupType("per_unit");
    setFormUtilityMarkupValue("0");
    setFormGeneratorMarkupType("per_unit");
    setFormGeneratorMarkupValue("0");
    setFormGstRate("18");
    setShowDialog(true);
  };

  const openEdit = (row: ProfileRow) => {
    setEditId(row.id);
    setFormName(row.name);
    setFormDescription(row.description ?? "");
    setFormUtilityPct(String(row.customer_utility_pct));
    setFormGeneratorPct(String(row.customer_generator_pct));
    setFormUtilityMarkupType(row.utility_markup_type);
    setFormUtilityMarkupValue(String(row.utility_markup_value));
    setFormGeneratorMarkupType(row.generator_markup_type);
    setFormGeneratorMarkupValue(String(row.generator_markup_value));
    setFormGstRate(String(row.customer_gst_rate));
    setShowDialog(true);
  };

  const handleUtilityPctChange = (v: string) => {
    setFormUtilityPct(v);
    const n = parseFloat(v);
    if (!isNaN(n) && n >= 0 && n <= 100) setFormGeneratorPct(String(100 - n));
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error("Name is required");
      return;
    }
    const utilityPct = parseFloat(formUtilityPct) || 0;
    const generatorPct = parseFloat(formGeneratorPct) || 0;
    if (Math.round((utilityPct + generatorPct) * 100) !== 10000) {
      toast.error("Utility % and Generator % must add up to 100");
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        description: formDescription || null,
        customer_utility_pct: utilityPct,
        customer_generator_pct: generatorPct,
        utility_markup_type: formUtilityMarkupType,
        utility_markup_value: parseFloat(formUtilityMarkupValue) || 0,
        generator_markup_type: formGeneratorMarkupType,
        generator_markup_value: parseFloat(formGeneratorMarkupValue) || 0,
        customer_gst_rate: parseFloat(formGstRate) || 0,
      };

      const url = editId
        ? `/api/admin/electricity-billing-profiles/${editId}`
        : "/api/admin/electricity-billing-profiles";
      const method = editId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.name?.[0] || data.error || "Failed to save");

      toast.success(editId ? "Profile updated" : "Profile created");
      setShowDialog(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (row: ProfileRow) => {
    try {
      const res = await fetch(`/api/admin/electricity-billing-profiles/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !row.is_active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update");
      toast.success(row.is_active ? "Profile deactivated" : "Profile activated");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    }
  };

  const formatMarkup = (type: "per_unit" | "percent", value: number) =>
    type === "per_unit" ? `+₹${value}/unit` : `+${value}%`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Electricity Billing Profiles</h1>
          <p className="text-muted-foreground text-sm">
            Reusable ratio-split + cost-plus-margin formulas, assignable to any contract&apos;s
            electricity config. The ratio re-splits the landlord bill&apos;s TOTAL units; the
            markup is added to that bill&apos;s captured landlord rate automatically each month.
          </p>
        </div>
        <Button onClick={openAdd} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Profile
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : profiles.length === 0 ? (
        <div className="border rounded-lg p-12 text-center space-y-2">
          <p className="font-medium text-muted-foreground">No billing profiles configured</p>
          <p className="text-sm text-muted-foreground">
            Add a profile, then assign it to a contract under Contract → Electricity tab.
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Split (Utility / DG)</th>
                <th className="text-left p-3 font-medium">Utility Margin</th>
                <th className="text-left p-3 font-medium">DG Margin</th>
                <th className="text-left p-3 font-medium">GST</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="p-3 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {profiles.map((row) => (
                <tr key={row.id} className="hover:bg-muted/20">
                  <td className="p-3">
                    <div className="font-medium">{row.name}</div>
                    {row.description && (
                      <div className="text-xs text-muted-foreground max-w-[280px] truncate">
                        {row.description}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {row.customer_utility_pct}% / {row.customer_generator_pct}%
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {formatMarkup(row.utility_markup_type, row.utility_markup_value)}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {formatMarkup(row.generator_markup_type, row.generator_markup_value)}
                  </td>
                  <td className="p-3 text-muted-foreground">{row.customer_gst_rate}%</td>
                  <td className="p-3">
                    <Badge variant={row.is_active ? "default" : "secondary"}>
                      {row.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleActive(row)}
                        title={row.is_active ? "Deactivate" : "Activate"}
                      >
                        <Power className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Profile" : "Add Billing Profile"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Standard 80/20, +1.30/+10 margin"
              />
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Optional notes on when to use this profile"
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Customer Utility %</Label>
                <Input
                  type="number" min="0" max="100" step="0.01"
                  value={formUtilityPct}
                  onChange={(e) => handleUtilityPctChange(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Customer Generator %</Label>
                <Input
                  type="number" min="0" max="100" step="0.01"
                  value={formGeneratorPct}
                  onChange={(e) => setFormGeneratorPct(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              % of the landlord bill&apos;s TOTAL units (utility + DG combined) allocated to each
              category on the customer invoice. Must add up to 100.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Utility Markup Type</Label>
                <Select value={formUtilityMarkupType} onValueChange={(v) => setFormUtilityMarkupType(v as "per_unit" | "percent")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_unit">Fixed ₹/unit</SelectItem>
                    <SelectItem value="percent">Percent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Utility Markup Value</Label>
                <Input
                  type="number" min="0" step="0.0001"
                  value={formUtilityMarkupValue}
                  onChange={(e) => setFormUtilityMarkupValue(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>DG Markup Type</Label>
                <Select value={formGeneratorMarkupType} onValueChange={(v) => setFormGeneratorMarkupType(v as "per_unit" | "percent")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_unit">Fixed ₹/unit</SelectItem>
                    <SelectItem value="percent">Percent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>DG Markup Value</Label>
                <Input
                  type="number" min="0" step="0.0001"
                  value={formGeneratorMarkupValue}
                  onChange={(e) => setFormGeneratorMarkupValue(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Added to that month&apos;s captured landlord rate automatically at approval —
              no manual monthly rate updates needed.
            </p>

            <div className="space-y-2">
              <Label>Customer GST %</Label>
              <Input
                type="number" min="0" max="28" step="0.01"
                value={formGstRate}
                onChange={(e) => setFormGstRate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editId ? "Save Changes" : "Create Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
