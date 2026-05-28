"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, CreditCard, Loader2, ShieldCheck, ShieldOff,
  Plus, Trash2, RefreshCw, User, Building2, Calendar,
  Clock, CheckCircle2, XCircle, AlertTriangle, Fingerprint,
  Scan, Info,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Employee {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  department: string | null;
  designation: string | null;
  employment_type: string | null;
  date_of_joining: string | null;
  cosec_ref_id: number | null;
  nfc_card_number: string | null;
  is_active: boolean;
  location: { id: string; name: string } | null;
}

interface AccessProfile {
  id: string;
  name: string;
  description: string | null;
  allowed_days: number[];
  from_time: string | null;
  until_time: string | null;
  cosec_user_group: number;
  is_default: boolean;
}

interface DeviceEnrollment {
  id: string;
  device_id: string;
  device_label: string;
  device_code: string;
  device_category: "entry_point" | "business_centre";
  location_name: string;
  enrollment_status: string;
  access_profile_id: string | null;
  profile_name: string | null;
  nfc_card_number: string | null;
  valid_from: string | null;
  valid_until: string | null;
  provisioned_at: string | null;
  biometric_enrolled_at: string | null;
  card_enrolled_at: string | null;
  blocked_at: string | null;
}

interface AvailableDevice {
  id: string;
  label: string;
  device_code: string;
  device_category: "entry_point" | "business_centre";
  location: { name: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDays(days: number[]): string {
  if (days.length === 7) return "All days";
  if (JSON.stringify(days.sort()) === JSON.stringify([1, 2, 3, 4, 5])) return "Mon – Fri";
  if (JSON.stringify(days.sort()) === JSON.stringify([0, 6])) return "Sat & Sun";
  return days.map(d => DAY_LABELS[d]).join(", ");
}

function formatTime(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatTimeRange(from: string | null, until: string | null): string {
  if (!from && !until) return "All hours";
  return `${formatTime(from)} – ${formatTime(until)}`;
}

const STATUS_CONFIG: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
  provisioned:     { label: "PIN only",    className: "bg-blue-50 text-blue-700 border-blue-200",     icon: <ShieldCheck size={11} /> },
  card_enrolled:   { label: "Card active", className: "bg-purple-50 text-purple-700 border-purple-200", icon: <CreditCard size={11} /> },
  fully_enrolled:  { label: "Card + Bio",  className: "bg-green-100 text-green-800 border-green-300",  icon: <Fingerprint size={11} /> },
  blocked:         { label: "Blocked",     className: "bg-red-50 text-red-700 border-red-200",         icon: <ShieldOff size={11} /> },
  deleted:         { label: "Revoked",     className: "bg-slate-50 text-slate-500 border-slate-200",   icon: <XCircle size={11} /> },
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [employee, setEmployee]         = useState<Employee | null>(null);
  const [enrollments, setEnrollments]   = useState<DeviceEnrollment[]>([]);
  const [profiles, setProfiles]         = useState<AccessProfile[]>([]);
  const [allDevices, setAllDevices]     = useState<AvailableDevice[]>([]);
  const [loading, setLoading]           = useState(true);

  // Card dialog
  const [cardDialog, setCardDialog]     = useState(false);
  const [cardNumber, setCardNumber]     = useState("");
  const [cardScanning, setCardScanning] = useState(false);
  const [cardSaving, setCardSaving]     = useState(false);

  // Grant access dialog
  const [grantDialog, setGrantDialog]   = useState(false);
  const [grantDeviceId, setGrantDeviceId]     = useState("");
  const [grantProfileId, setGrantProfileId]   = useState("");
  const [grantValidFrom, setGrantValidFrom]   = useState("");
  const [grantValidUntil, setGrantValidUntil] = useState("");
  const [granting, setGranting]               = useState(false);

  // Per-row action loading
  const [rowLoading, setRowLoading]     = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [
      { data: emp },
      { data: cau },
      { data: profs },
      { data: devs },
    ] = await Promise.all([
      supabase.from("employees").select("*, location:locations(id,name)").eq("id", id).single(),
      supabase.from("cosec_access_users")
        .select("id, device_id, cosec_user_id, enrollment_status, access_profile_id, nfc_card_number, valid_from, valid_until, provisioned_at, biometric_enrolled_at, card_enrolled_at, blocked_at")
        .eq("entity_id", id).eq("user_type", "employee").neq("enrollment_status", "deleted"),
      supabase.from("employee_access_profiles").select("*").order("name"),
      supabase.from("cosec_devices").select("id, label, device_code, device_category, location:locations(name)").eq("is_enabled", true).order("label"),
    ]);

    if (!emp) { router.push("/admin/employees"); return; }
    setEmployee(emp as Employee);
    setProfiles((profs ?? []) as AccessProfile[]);
    setAllDevices((devs ?? []) as unknown as AvailableDevice[]);

    // Enrich enrollments with device label and profile name
    const profileMap = new Map((profs ?? []).map((p: AccessProfile) => [p.id, p.name]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deviceMap  = new Map((devs ?? []).map((d: any) => [
      d.id,
      { label: d.label as string, device_code: d.device_code as string, category: d.device_category as string, location: (Array.isArray(d.location) ? d.location[0]?.name : d.location?.name) ?? "" },
    ]));

    const enriched: DeviceEnrollment[] = (cau ?? []).map((row: {
      id: string; device_id: string; enrollment_status: string; access_profile_id: string | null;
      nfc_card_number: string | null; valid_from: string | null; valid_until: string | null;
      provisioned_at: string | null; biometric_enrolled_at: string | null; card_enrolled_at: string | null; blocked_at: string | null;
    }) => {
      const dev = deviceMap.get(row.device_id);
      return {
        ...row,
        device_label: dev?.label ?? "Unknown",
        device_code: dev?.device_code ?? "",
        device_category: (dev?.category ?? "entry_point") as "entry_point" | "business_centre",
        location_name: dev?.location ?? "",
        profile_name: row.access_profile_id ? (profileMap.get(row.access_profile_id) ?? null) : null,
      };
    });
    setEnrollments(enriched);
    setLoading(false);
  }, [id, router]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // ── Card management ─────────────────────────────────────────────────────────

  async function handleScanCard() {
    if (!employee) return;
    setCardScanning(true);
    try {
      // Use first available entry_point device for scanning
      const entryDevice = allDevices.find(d => d.device_category === "entry_point");
      if (!entryDevice) { toast.error("No entry-point device available for scanning"); return; }
      const res = await fetch("/api/cosec/scan-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: entryDevice.id }),
      });
      const data = await res.json();
      if (data.cardNumber) setCardNumber(data.cardNumber);
      else toast.error(data.error ?? "No card detected");
    } finally { setCardScanning(false); }
  }

  async function handleSaveCard() {
    if (!employee || !cardNumber.trim()) return;
    setCardSaving(true);
    try {
      const res = await fetch("/api/cosec/assign-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employee.id, card_number: cardNumber.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success("Card assigned and pushed to all enrolled devices");
        setCardDialog(false);
        setCardNumber("");
        await load();
      } else {
        toast.error(data.error ?? "Failed to assign card");
      }
    } finally { setCardSaving(false); }
  }

  async function handleUnassignCard() {
    if (!employee) return;
    setCardSaving(true);
    try {
      const res = await fetch("/api/cosec/assign-card", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employee.id }),
      });
      const data = await res.json();
      if (res.ok) { toast.success("Card unassigned"); setCardDialog(false); await load(); }
      else toast.error(data.error ?? "Failed");
    } finally { setCardSaving(false); }
  }

  // ── Grant access ────────────────────────────────────────────────────────────

  const defaultProfile = profiles.find(p => p.is_default);
  const enrolledDeviceIds = new Set(enrollments.map(e => e.device_id));
  const availableToAdd = allDevices.filter(d => !enrolledDeviceIds.has(d.id));

  function openGrantDialog() {
    setGrantDeviceId(availableToAdd[0]?.id ?? "");
    setGrantProfileId(defaultProfile?.id ?? profiles[0]?.id ?? "");
    setGrantValidFrom("");
    setGrantValidUntil("");
    setGrantDialog(true);
  }

  async function handleGrant() {
    if (!employee || !grantDeviceId || !grantProfileId) return;
    setGranting(true);
    try {
      const res = await fetch("/api/cosec/employee-device-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employee.id,
          device_id: grantDeviceId,
          access_profile_id: grantProfileId,
          valid_from: grantValidFrom || undefined,
          valid_until: grantValidUntil || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Access granted on ${data.device} (${data.profile})`);
        setGrantDialog(false);
        await load();
      } else {
        toast.error(data.error ?? "Failed to grant access");
      }
    } finally { setGranting(false); }
  }

  // ── Revoke access ───────────────────────────────────────────────────────────

  async function handleRevoke(enrollment: DeviceEnrollment) {
    if (!employee) return;
    setRowLoading(prev => ({ ...prev, [enrollment.id]: true }));
    try {
      const res = await fetch("/api/cosec/employee-device-access", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employee.id, device_id: enrollment.device_id }),
      });
      const data = await res.json();
      if (res.ok) { toast.success(`Access revoked on ${enrollment.device_label}`); await load(); }
      else toast.error(data.error ?? "Failed to revoke");
    } finally {
      setRowLoading(prev => { const n = { ...prev }; delete n[enrollment.id]; return n; });
    }
  }

  // ── Block / unblock ─────────────────────────────────────────────────────────

  async function handleBlock(enrollment: DeviceEnrollment) {
    setRowLoading(prev => ({ ...prev, [enrollment.id + "_block"]: true }));
    try {
      const endpoint = enrollment.enrollment_status === "blocked" ? "/api/cosec/restore-user" : "/api/cosec/block-user";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: enrollment.id }),
      });
      const data = await res.json();
      if (res.ok) { toast.success(data.message ?? "Done"); await load(); }
      else toast.error(data.error ?? "Failed");
    } finally {
      setRowLoading(prev => { const n = { ...prev }; delete n[enrollment.id + "_block"]; return n; });
    }
  }

  if (loading || !employee) {
    return <div className="flex items-center justify-center h-64"><Loader2 size={32} className="animate-spin text-muted-foreground" /></div>;
  }

  const selectedProfile = profiles.find(p => p.id === grantProfileId);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/admin/employees")} className="mt-0.5">
          <ArrowLeft size={18} />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">{employee.full_name}</h1>
            <Badge variant={employee.is_active ? "default" : "secondary"}>
              {employee.is_active ? "Active" : "Inactive"}
            </Badge>
            {employee.cosec_ref_id && (
              <span className="font-mono text-xs bg-slate-100 text-slate-600 border border-slate-200 rounded px-1.5 py-0.5">
                Ref #{employee.cosec_ref_id}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {[employee.designation, employee.department].filter(Boolean).join(" · ")}
            {employee.location && ` · ${(employee.location as { name: string }).name}`}
          </p>
        </div>
      </div>

      {/* ── Info + Card ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Employee Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <User size={14} /> Employee Info
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {employee.email && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span>{employee.email}</span>
              </div>
            )}
            {employee.phone && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone</span>
                <span>{employee.phone}</span>
              </div>
            )}
            {employee.employment_type && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="capitalize">{employee.employment_type.replace("_", " ")}</span>
              </div>
            )}
            {employee.date_of_joining && (
              <div className="flex justify-between">
                <span className="text-muted-foreground flex items-center gap-1"><Calendar size={12} /> Joined</span>
                <span>{formatDate(employee.date_of_joining)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* NFC Card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CreditCard size={14} /> NFC Card
            </CardTitle>
          </CardHeader>
          <CardContent>
            {employee.nfc_card_number ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                  <code className="text-sm bg-slate-50 border rounded px-2 py-1 flex-1 font-mono">
                    {employee.nfc_card_number}
                  </code>
                </div>
                <p className="text-xs text-muted-foreground">
                  Card is active on all enrolled devices. Tap the device to verify.
                </p>
                <Button size="sm" variant="outline" className="w-full" onClick={() => { setCardNumber(employee.nfc_card_number ?? ""); setCardDialog(true); }}>
                  <CreditCard size={13} className="mr-1.5" /> Manage Card
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-amber-600">
                  <AlertTriangle size={16} />
                  <span className="text-sm font-medium">No card assigned</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Employee can only use PIN access until a card is assigned.
                </p>
                <Button size="sm" className="w-full" onClick={() => { setCardNumber(""); setCardDialog(true); }}>
                  <Plus size={13} className="mr-1.5" /> Assign Card
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Device Access ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 size={14} /> Device Access
              <Badge variant="outline" className="ml-1 text-xs">{enrollments.length} active</Badge>
            </CardTitle>
            <Button size="sm" onClick={openGrantDialog} disabled={availableToAdd.length === 0}>
              <Plus size={13} className="mr-1.5" /> Grant Access
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {enrollments.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground text-sm">
              <ShieldOff size={28} className="mx-auto mb-2 opacity-30" />
              No device access granted yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Access Profile</TableHead>
                  <TableHead>Validity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {enrollments.map(e => {
                  const cfg = STATUS_CONFIG[e.enrollment_status] ?? STATUS_CONFIG.provisioned;
                  const isBlocked = e.enrollment_status === "blocked";
                  return (
                    <TableRow key={e.id}>
                      <TableCell>
                        <div className="font-medium text-sm">{e.device_label}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <span className="font-mono">{e.device_code}</span>
                          <span>·</span>
                          <span>{e.location_name}</span>
                          <Badge variant="outline" className={`text-[10px] px-1 py-0 ${e.device_category === "business_centre" ? "border-amber-300 text-amber-700" : "border-blue-300 text-blue-700"}`}>
                            {e.device_category === "business_centre" ? "Conf" : "Entry"}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        {e.profile_name ? (
                          <span className="text-sm">{e.profile_name}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">No profile</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.valid_from || e.valid_until ? (
                          <span>
                            {e.valid_from ? formatDate(e.valid_from) : "—"} → {e.valid_until ? formatDate(e.valid_until) : "No expiry"}
                          </span>
                        ) : (
                          <span className="italic">No expiry</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs flex items-center gap-1 w-fit ${cfg.className}`}>
                          {cfg.icon} {cfg.label}
                        </Badge>
                        {e.biometric_enrolled_at && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                            <Fingerprint size={9} /> Bio enrolled
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm" variant="ghost"
                            className={isBlocked ? "text-green-600 hover:text-green-700" : "text-amber-600 hover:text-amber-700"}
                            disabled={!!rowLoading[e.id + "_block"]}
                            onClick={() => handleBlock(e)}
                            title={isBlocked ? "Restore access" : "Block access"}
                          >
                            {rowLoading[e.id + "_block"]
                              ? <Loader2 size={13} className="animate-spin" />
                              : isBlocked ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="text-red-500 hover:text-red-600"
                            disabled={!!rowLoading[e.id]}
                            onClick={() => handleRevoke(e)}
                            title="Revoke access"
                          >
                            {rowLoading[e.id] ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Card Dialog ─────────────────────────────────────────────────────── */}
      <Dialog open={cardDialog} onOpenChange={setCardDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {employee.nfc_card_number ? "Manage NFC Card" : "Assign NFC Card"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Card Number (CSN)</Label>
              <div className="flex gap-2">
                <Input
                  value={cardNumber}
                  onChange={e => setCardNumber(e.target.value)}
                  placeholder="Tap card or enter number"
                  className="font-mono"
                />
                <Button variant="outline" onClick={handleScanCard} disabled={cardScanning}>
                  {cardScanning ? <Loader2 size={14} className="animate-spin" /> : <Scan size={14} />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Click Scan then tap the card on an entry device, or type the CSN manually.
              </p>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            {employee.nfc_card_number && (
              <Button variant="destructive" onClick={handleUnassignCard} disabled={cardSaving} className="sm:mr-auto">
                {cardSaving ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
                Unassign Card
              </Button>
            )}
            <Button variant="outline" onClick={() => setCardDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveCard} disabled={cardSaving || !cardNumber.trim()}>
              {cardSaving ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
              Save Card
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Grant Access Dialog ──────────────────────────────────────────────── */}
      <Dialog open={grantDialog} onOpenChange={setGrantDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Grant Device Access</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">

            <div className="space-y-1.5">
              <Label>Device</Label>
              <Select value={grantDeviceId} onValueChange={setGrantDeviceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select device" />
                </SelectTrigger>
                <SelectContent>
                  {availableToAdd.map(d => (
                    <SelectItem key={d.id} value={d.id}>
                      <span className="font-mono text-xs text-muted-foreground mr-2">{d.device_code}</span>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Access Profile</Label>
              <Select value={grantProfileId} onValueChange={setGrantProfileId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      <span>{p.name}</span>
                      {p.is_default && <span className="ml-1 text-xs text-muted-foreground">(default)</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProfile && (
                <div className="bg-slate-50 border rounded p-2.5 text-xs space-y-1 text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Calendar size={11} /> {formatDays(selectedProfile.allowed_days)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Clock size={11} /> {formatTimeRange(selectedProfile.from_time, selectedProfile.until_time)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Info size={11} /> COSEC user-group {selectedProfile.cosec_user_group}
                  </div>
                  {(selectedProfile.from_time || selectedProfile.until_time) && (
                    <div className="flex items-start gap-1.5 text-amber-600 pt-1 border-t mt-1">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                      Time restrictions require user-group {selectedProfile.cosec_user_group} to be configured in the device admin.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Valid From <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input type="date" value={grantValidFrom} onChange={e => setGrantValidFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Valid Until <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input type="date" value={grantValidUntil} onChange={e => setGrantValidUntil(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantDialog(false)}>Cancel</Button>
            <Button onClick={handleGrant} disabled={granting || !grantDeviceId || !grantProfileId}>
              {granting ? <Loader2 size={13} className="animate-spin mr-1" /> : <ShieldCheck size={13} className="mr-1" />}
              Grant Access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
