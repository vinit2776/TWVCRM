"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus, Loader2, TicketCheck, Pencil, ToggleLeft, ToggleRight, Copy, Send, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SellPackageDialog } from "@/components/packages/sell-package-dialog";
import { formatCurrency } from "@/lib/utils";
import {
  CREDIT_TYPE_LABELS,
  PREPAID_PURCHASE_STATUS_LABELS,
  PREPAID_PURCHASE_STATUS_COLORS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { PrepaidPackage, PrepaidPurchase, Space } from "@/types";
import { useLocations } from "@/hooks/use-locations";

const WORKSPACE_TYPE_LABELS: Record<string, string> = {
  hot_desk: "Hot Desk",
  dedicated_desk: "Dedicated Desk",
  private_office: "Private Office",
  meeting_room: "Meeting Room",
  conference_room: "Conference Room",
  virtual_office: "Virtual Office",
};

const WORKSPACE_TYPES = Object.keys(WORKSPACE_TYPE_LABELS);

// ─── Package Form Dialog ─────────────────────────────────────────────────────

interface PackageFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  package?: PrepaidPackage | null;
  onSuccess: () => void;
}

function PackageFormDialog({ open, onOpenChange, package: pkg, onSuccess }: PackageFormDialogProps) {
  const { locations } = useLocations();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [locationId, setLocationId] = useState("__none");
  const [workspaceType, setWorkspaceType] = useState("__none");
  const [spaceId, setSpaceId] = useState("__none");
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [creditType, setCreditType] = useState("hours");
  const [totalCredits, setTotalCredits] = useState("");
  const [price, setPrice] = useState("");
  const [validityDays, setValidityDays] = useState("30");
  const [saving, setSaving] = useState(false);

  // Load spaces when location changes
  useEffect(() => {
    if (!locationId || locationId === "__none") {
      setSpaces([]);
      setSpaceId("__none");
      return;
    }
    setSpacesLoading(true);
    fetch(`/api/spaces?location_id=${locationId}&is_active=true&limit=50`)
      .then(r => r.json())
      .then(json => setSpaces(json.data || []))
      .catch(() => setSpaces([]))
      .finally(() => setSpacesLoading(false));
  }, [locationId]);

  // When a specific space is chosen, auto-fill workspace_type from that space
  useEffect(() => {
    if (spaceId && spaceId !== "__none") {
      const found = spaces.find(s => s.id === spaceId);
      if (found?.workspace_type) {
        setWorkspaceType(found.workspace_type);
      }
    }
  }, [spaceId, spaces]);

  useEffect(() => {
    if (pkg) {
      setName(pkg.name);
      setDescription(pkg.description || "");
      setLocationId(pkg.location_id || "__none");
      setWorkspaceType(pkg.workspace_type || "__none");
      setSpaceId(pkg.space_id || "__none");
      setCreditType(pkg.credit_type);
      setTotalCredits(String(pkg.total_credits));
      setPrice(String(pkg.price));
      setValidityDays(String(pkg.validity_days));
    } else {
      setName(""); setDescription(""); setLocationId("__none"); setWorkspaceType("__none");
      setSpaceId("__none"); setSpaces([]);
      setCreditType("hours"); setTotalCredits(""); setPrice(""); setValidityDays("30");
    }
  }, [pkg, open]);

  const handleSubmit = async () => {
    if (!name.trim()) { toast.error("Package name is required"); return; }
    if (!totalCredits || isNaN(Number(totalCredits))) { toast.error("Total credits required"); return; }
    if (!price || isNaN(Number(price))) { toast.error("Price required"); return; }

    setSaving(true);
    try {
      const resolvedSpaceId = spaceId && spaceId !== "__none" ? spaceId : undefined;
      // When a specific space is selected, auto-derive workspace_type from it
      const resolvedWorkspaceType = (() => {
        if (resolvedSpaceId) {
          const found = spaces.find(s => s.id === resolvedSpaceId);
          return found?.workspace_type || (workspaceType !== "__none" ? workspaceType : undefined);
        }
        return (workspaceType && workspaceType !== "__none") ? workspaceType : undefined;
      })();

      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        location_id: (locationId && locationId !== "__none") ? locationId : undefined,
        workspace_type: resolvedWorkspaceType,
        space_id: resolvedSpaceId,
        credit_type: creditType,
        total_credits: Number(totalCredits),
        price: Number(price),
        validity_days: Number(validityDays),
      };

      const res = pkg
        ? await fetch(`/api/prepaid-packages/${pkg.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await fetch("/api/prepaid-packages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const json = await res.json();
      if (res.ok) {
        toast.success(pkg ? "Package updated" : "Package created");
        onSuccess();
        onOpenChange(false);
      } else {
        toast.error(json.error || "Failed to save package");
      }
    } catch { toast.error("Failed to save package"); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{pkg ? "Edit Package" : "New Package"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. 10hr Hot Desk Pass" />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Optional description" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={locationId} onValueChange={v => { setLocationId(v); setSpaceId("__none"); }}>
                <SelectTrigger><SelectValue placeholder="All locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">All locations</SelectItem>
                  {locations.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>
                Specific Space <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              {spacesLoading ? (
                <div className="flex items-center h-9 text-xs text-muted-foreground gap-1 px-3 border rounded-md">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                </div>
              ) : (
                <Select
                  value={spaceId}
                  onValueChange={setSpaceId}
                  disabled={!locationId || locationId === "__none"}
                >
                  <SelectTrigger><SelectValue placeholder="All spaces" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">All spaces</SelectItem>
                    {spaces.map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>
              Space Type{" "}
              <span className="text-muted-foreground text-xs">
                (auto-filled when specific space is selected)
              </span>
            </Label>
            <Select
              value={workspaceType}
              onValueChange={setWorkspaceType}
              disabled={!!(spaceId && spaceId !== "__none")}
            >
              <SelectTrigger><SelectValue placeholder="All types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">All types</SelectItem>
                {WORKSPACE_TYPES.map(t => <SelectItem key={t} value={t}>{WORKSPACE_TYPE_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Credit Type *</Label>
              <Select value={creditType} onValueChange={setCreditType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                  <SelectItem value="bookings">Booking Slots</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Total Credits *</Label>
              <Input type="number" min="1" value={totalCredits} onChange={e => setTotalCredits(e.target.value)} placeholder="e.g. 10" />
            </div>
            <div className="space-y-2">
              <Label>Validity (days) *</Label>
              <Input type="number" min="1" value={validityDays} onChange={e => setValidityDays(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Price (₹) *</Label>
            <Input type="number" min="0" value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. 5000" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pkg ? "Save Changes" : "Create Package"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Extend Purchase Dialog ──────────────────────────────────────────────────

interface ExtendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PrepaidPurchase | null;
  onSuccess: () => void;
}

function ExtendPurchaseDialog({ open, onOpenChange, purchase, onSuccess }: ExtendDialogProps) {
  const [newDate, setNewDate] = useState("");
  const [extensionNotes, setExtensionNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (purchase) {
      setNewDate(purchase.expires_at);
      setExtensionNotes("");
    }
  }, [purchase]);

  const handleSubmit = async () => {
    if (!newDate) { toast.error("New expiry date is required"); return; }
    if (!purchase) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/prepaid-purchases/${purchase.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extend", new_expires_at: newDate, extension_notes: extensionNotes.trim() || undefined }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success("Validity extended");
        onSuccess();
        onOpenChange(false);
      } else {
        toast.error(json.error || "Failed to extend");
      }
    } catch { toast.error("Failed to extend"); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Extend Validity</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>New Expiry Date *</Label>
            <Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} min={new Date().toISOString().split("T")[0]} />
          </div>
          <div className="space-y-2">
            <Label>Extension Notes</Label>
            <Textarea value={extensionNotes} onChange={e => setExtensionNotes(e.target.value)} rows={2} placeholder="Reason for extension..." />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Extend
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PackagesPage() {
  const [packages, setPackages] = useState<PrepaidPackage[]>([]);
  const [purchases, setPurchases] = useState<PrepaidPurchase[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [purchasesLoading, setPurchasesLoading] = useState(true);

  const [packageFormOpen, setPackageFormOpen] = useState(false);
  const [editingPackage, setEditingPackage] = useState<PrepaidPackage | null>(null);
  const [sellOpen, setSellOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendingPurchase, setExtendingPurchase] = useState<PrepaidPurchase | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const fetchPackages = useCallback(async () => {
    setPackagesLoading(true);
    try {
      const res = await fetch("/api/prepaid-packages");
      if (res.ok) {
        const json = await res.json();
        setPackages(json.data || []);
      }
    } catch { /* ignore */ }
    setPackagesLoading(false);
  }, []);

  const fetchPurchases = useCallback(async () => {
    setPurchasesLoading(true);
    try {
      const res = await fetch("/api/prepaid-purchases?limit=100");
      if (res.ok) {
        const json = await res.json();
        setPurchases(json.data || []);
      }
    } catch { /* ignore */ }
    setPurchasesLoading(false);
  }, []);

  useEffect(() => { fetchPackages(); }, [fetchPackages]);
  useEffect(() => { fetchPurchases(); }, [fetchPurchases]);

  const handleToggleActive = async (pkg: PrepaidPackage) => {
    const res = await fetch(`/api/prepaid-packages/${pkg.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !pkg.is_active }),
    });
    if (res.ok) {
      toast.success(pkg.is_active ? "Package deactivated" : "Package activated");
      fetchPackages();
    } else {
      toast.error("Failed to update");
    }
  };

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      toast.success("Payment link copied to clipboard");
    }).catch(() => toast.error("Failed to copy"));
  };

  const handleResendLink = async (purchase: PrepaidPurchase) => {
    setResendingId(purchase.id);
    try {
      const res = await fetch(`/api/prepaid-purchases/${purchase.id}/payment-link`, { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        toast.success("Payment link sent to customer");
        if (!purchase.razorpay_payment_link_url && json.data?.payment_link_url) {
          fetchPurchases();
        }
      } else {
        toast.error(json.error || "Failed to send payment link");
      }
    } catch { toast.error("Failed to send payment link"); }
    finally { setResendingId(null); }
  };

  // Helper: show specific space name, workspace type, or "All types"
  const renderSpaceType = (pkg: PrepaidPackage) => {
    const space = pkg.space as { name?: string } | undefined;
    if (space?.name) {
      return (
        <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700">
          {space.name}
        </Badge>
      );
    }
    if (pkg.workspace_type) {
      return (
        <Badge variant="outline" className="text-xs">
          {WORKSPACE_TYPE_LABELS[pkg.workspace_type] || pkg.workspace_type}
        </Badge>
      );
    }
    return <span className="text-muted-foreground text-xs">All types</span>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TicketCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Packages</h1>
            <p className="text-sm text-muted-foreground">Prepaid bulk hour &amp; day passes</p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="packages">
        <TabsList>
          <TabsTrigger value="packages">Package Templates</TabsTrigger>
          <TabsTrigger value="purchases">Customer Purchases</TabsTrigger>
        </TabsList>

        {/* ── Packages Tab ── */}
        <TabsContent value="packages" className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => { setEditingPackage(null); setPackageFormOpen(true); }}>
              <Plus className="mr-1 h-4 w-4" /> New Package
            </Button>
          </div>

          {packagesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : packages.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                No packages yet. Create your first package template.
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Name</th>
                    <th className="px-4 py-3 text-left font-medium">Credits</th>
                    <th className="px-4 py-3 text-left font-medium">Price</th>
                    <th className="px-4 py-3 text-left font-medium">Validity</th>
                    <th className="px-4 py-3 text-left font-medium">Space/Type</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map(pkg => (
                    <tr key={pkg.id} className="border-b hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="font-medium">{pkg.name}</div>
                        {pkg.description && <div className="text-xs text-muted-foreground">{pkg.description}</div>}
                        {pkg.location && <div className="text-xs text-muted-foreground">{(pkg.location as { name?: string }).name}</div>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {pkg.total_credits} {CREDIT_TYPE_LABELS[pkg.credit_type]}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-medium">{formatCurrency(pkg.price)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{pkg.validity_days} days</td>
                      <td className="px-4 py-3">{renderSpaceType(pkg)}</td>
                      <td className="px-4 py-3">
                        <Badge variant={pkg.is_active ? "default" : "secondary"}>
                          {pkg.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => { setEditingPackage(pkg); setPackageFormOpen(true); }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => handleToggleActive(pkg)}
                          >
                            {pkg.is_active
                              ? <ToggleRight className="h-4 w-4 text-green-600" />
                              : <ToggleLeft className="h-4 w-4 text-muted-foreground" />}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setSellOpen(true)}
                          >
                            Sell
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* ── Purchases Tab ── */}
        <TabsContent value="purchases" className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setSellOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Sell Package
            </Button>
          </div>

          {purchasesLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : purchases.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                No packages sold yet. Use &ldquo;Sell Package&rdquo; to record a customer purchase.
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Customer</th>
                    <th className="px-4 py-3 text-left font-medium">Package</th>
                    <th className="px-4 py-3 text-left font-medium">Credits</th>
                    <th className="px-4 py-3 text-left font-medium">Paid</th>
                    <th className="px-4 py-3 text-left font-medium">Expires</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map(p => {
                    const creditsRemaining = p.credits_remaining ?? (Number(p.total_credits) - Number(p.credits_used));
                    const pct = Number(p.total_credits) > 0 ? creditsRemaining / Number(p.total_credits) : 0;
                    const pkg = p.package as { name?: string } | undefined;
                    const lead = p.lead as { first_name?: string; last_name?: string } | undefined;
                    const isPending = p.payment_status === "pending_payment";

                    return (
                      <tr key={p.id} className={`border-b hover:bg-muted/20 ${isPending ? "bg-amber-50/30" : ""}`}>
                        <td className="px-4 py-3">
                          {lead
                            ? <div className="font-medium">{lead.first_name} {lead.last_name}</div>
                            : <div className="font-medium text-muted-foreground">—</div>}
                          {p.company_name && <div className="text-xs text-muted-foreground">{p.company_name}</div>}
                        </td>
                        <td className="px-4 py-3">{pkg?.name || "—"}</td>
                        <td className="px-4 py-3">
                          {isPending ? (
                            <span className="text-xs text-amber-600">Awaiting payment</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${pct < 0.2 ? "bg-amber-400" : "bg-green-500"}`}
                                  style={{ width: `${pct * 100}%` }}
                                />
                              </div>
                              <span className="text-xs">
                                {creditsRemaining}/{p.total_credits} {CREDIT_TYPE_LABELS[p.credit_type]}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">{formatCurrency(p.price_paid)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {new Date(p.expires_at + "T00:00:00").toLocaleDateString("en-IN", {
                            day: "numeric", month: "short", year: "numeric",
                          })}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <Badge className={`text-xs ${PREPAID_PURCHASE_STATUS_COLORS[p.status]}`} variant="outline">
                              {PREPAID_PURCHASE_STATUS_LABELS[p.status]}
                            </Badge>
                            {isPending && (
                              <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200" variant="outline">
                                <Clock className="h-2.5 w-2.5 mr-1" />
                                Payment Pending
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {isPending && p.razorpay_payment_link_url && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                title="Copy payment link"
                                onClick={() => handleCopyLink(p.razorpay_payment_link_url!)}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {isPending && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs gap-1"
                                onClick={() => handleResendLink(p)}
                                disabled={resendingId === p.id}
                              >
                                {resendingId === p.id
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <Send className="h-3 w-3" />
                                }
                                {p.razorpay_payment_link_url ? "Resend" : "Send Link"}
                              </Button>
                            )}
                            {!isPending && p.status !== "exhausted" && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => { setExtendingPurchase(p); setExtendOpen(true); }}
                              >
                                Extend
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <PackageFormDialog
        open={packageFormOpen}
        onOpenChange={setPackageFormOpen}
        package={editingPackage}
        onSuccess={fetchPackages}
      />

      <SellPackageDialog
        open={sellOpen}
        onOpenChange={setSellOpen}
        onSuccess={fetchPurchases}
      />

      <ExtendPurchaseDialog
        open={extendOpen}
        onOpenChange={setExtendOpen}
        purchase={extendingPurchase}
        onSuccess={fetchPurchases}
      />
    </div>
  );
}
