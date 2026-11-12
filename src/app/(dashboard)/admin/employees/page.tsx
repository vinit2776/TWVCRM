"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  UserPlus,
  Search,
  CreditCard,
  ShieldOff,
  ShieldCheck,
  RefreshCw,
  Loader2,
  MonitorSmartphone,
  Users,
  Fingerprint,
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Employee {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  department: string | null;
  designation: string | null;
  location_id: string | null;
  cosec_ref_id: number | null;
  nfc_card_number: string | null;
  is_active: boolean;
  created_at: string;
  location: { id: string; name: string } | null;
  enrollments: EnrollmentSummary[];
  is_crm_user?: boolean;
  crm_role?: string;
}

interface EnrollmentSummary {
  device_id: string;
  device_label: string;
  location_name: string;
  enrollment_status: string;
}

interface Location {
  id: string;
  name: string;
}

interface Device {
  id: string;
  label: string;
  location_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  location: any;
}

interface ProvisionResult {
  provisioned: number;
  alreadyEnrolled: number;
  failed: { device_id: string; label: string; error: string }[];
}

// ── Status helpers ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending:            { label: "Pending",         className: "bg-gray-100 text-gray-600" },
  provisioned:        { label: "Provisioned",     className: "bg-blue-50 text-blue-700 border-blue-200" },
  biometric_enrolled: { label: "Biometric",       className: "bg-green-50 text-green-700 border-green-200" },
  card_enrolled:      { label: "Card active",     className: "bg-purple-50 text-purple-700 border-purple-200" },
  fully_enrolled:     { label: "Card + Bio",      className: "bg-green-100 text-green-800 border-green-300" },
  blocked:            { label: "Blocked",         className: "bg-red-50 text-red-700 border-red-200" },
};

const CARD_ACTIVE_STATUSES = new Set(["card_enrolled", "fully_enrolled"]);

// ── Enrollment badge ───────────────────────────────────────────────────────────
// Shows two distinct numbers:
//   • Provisioned: on device (can use PIN)
//   • Card active: card binding confirmed (tap-to-enter works)
// These are the two states that matter operationally.

function EnrollmentBadge({
  emp,
  totalDevices,
  failedDevices,
}: {
  emp: Employee;
  totalDevices: number;
  failedDevices?: { device_id: string; label: string; error: string }[];
}) {
  const active   = emp.enrollments.filter(e => e.enrollment_status !== "blocked" && e.enrollment_status !== "deleted");
  const cardActive = active.filter(e => CARD_ACTIVE_STATUSES.has(e.enrollment_status));
  const blocked  = emp.enrollments.filter(e => e.enrollment_status === "blocked");
  const hasFailed = failedDevices && failedDevices.length > 0;

  if (emp.enrollments.length === 0 && !hasFailed) {
    return <Badge className="bg-gray-100 text-gray-500 text-xs">Not enrolled</Badge>;
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {active.length > 0 && (
        <Badge className="bg-blue-50 text-blue-700 border-blue-200 text-xs">
          <MonitorSmartphone className="h-3 w-3 mr-1" />
          {active.length}/{totalDevices} provisioned
        </Badge>
      )}
      {cardActive.length > 0 && (
        <Badge className="bg-purple-50 text-purple-700 border-purple-200 text-xs">
          <CreditCard className="h-3 w-3 mr-1" />
          {cardActive.length} card active
        </Badge>
      )}
      {blocked.length > 0 && (
        <Badge className="bg-red-50 text-red-600 border-red-200 text-xs">
          <ShieldOff className="h-3 w-3 mr-1" />
          {blocked.length} blocked
        </Badge>
      )}
      {hasFailed && (
        <Badge className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
          <AlertTriangle className="h-3 w-3 mr-1" />
          {failedDevices.length} failed
        </Badge>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  const supabase = createClient();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [totalDevices, setTotalDevices] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");

  // Per-employee provision failure state — persists until re-provision clears it
  const [provisionFailures, setProvisionFailures] = useState<Record<string, ProvisionResult["failed"]>>({});

  // Add employee dialog
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    full_name: "", phone: "", email: "",
    department: "", designation: "", location_id: "",
  });

  // Card dialog — assign or unassign
  const [cardDialog, setCardDialog] = useState<{
    employee: Employee;
    mode: "assign" | "unassign";
    deviceId: string;
  } | null>(null);
  const [cardScanning, setCardScanning] = useState(false);
  const [cardUnassigning, setCardUnassigning] = useState(false);

  // Action loading
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [empRes, locRes, devRes, usersRes] = await Promise.all([
      supabase
        .from("employees")
        .select("*, location:locations(id, name)")
        .order("full_name"),
      supabase.from("locations").select("id, name").order("name"),
      supabase
        .from("cosec_devices")
        .select("id, label, location_id, location:locations(name)")
        .eq("is_enabled", true)
        .eq("device_category", "entry_point"),
      supabase
        .from("users")
        .select("id, full_name, email, phone, role, is_active")
        .order("full_name"),
    ]);

    const allDevices = (devRes.data ?? []) as Device[];
    setTotalDevices(allDevices.length);
    setDevices(allDevices);
    setLocations(locRes.data ?? []);

    if (empRes.data) {
      const { data: enrollments } = await supabase
        .from("cosec_access_users")
        .select("entity_id, device_id, enrollment_status, device:cosec_devices(label, location:locations(name))")
        .eq("user_type", "employee")
        .neq("enrollment_status", "deleted");

      const enrollByEmp = new Map<string, EnrollmentSummary[]>();
      for (const e of enrollments ?? []) {
        if (!enrollByEmp.has(e.entity_id)) enrollByEmp.set(e.entity_id, []);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dev = e.device as any;
        enrollByEmp.get(e.entity_id)!.push({
          device_id: e.device_id,
          device_label: dev?.label ?? "",
          location_name: dev?.location?.name ?? "",
          enrollment_status: e.enrollment_status,
        });
      }

      const enriched: Employee[] = (empRes.data as Omit<Employee, "enrollments" | "is_crm_user" | "crm_role">[]).map(emp => ({
        ...emp,
        enrollments: enrollByEmp.get(emp.id) ?? [],
      }));

      // Merge CRM users that don't already exist in employees (matched by email)
      const employeeEmails = new Set(enriched.map(e => e.email?.toLowerCase()).filter(Boolean));
      const crmUsers = (usersRes.data ?? []) as { id: string; full_name: string; email: string | null; phone: string | null; role: string; is_active: boolean }[];
      for (const u of crmUsers) {
        if (u.email && employeeEmails.has(u.email.toLowerCase())) continue;
        enriched.push({
          id: u.id,
          full_name: u.full_name,
          email: u.email,
          phone: u.phone,
          department: null,
          designation: u.role,
          location_id: null,
          cosec_ref_id: null,
          nfc_card_number: null,
          is_active: u.is_active,
          created_at: "",
          location: null,
          enrollments: [],
          is_crm_user: true,
          crm_role: u.role,
        });
      }

      enriched.sort((a, b) => a.full_name.localeCompare(b.full_name));
      setEmployees(enriched);
    }

    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const departments = useMemo(() => {
    const d = new Set(employees.map(e => e.department).filter(Boolean) as string[]);
    return Array.from(d).sort();
  }, [employees]);

  const filtered = useMemo(() => {
    let list = employees;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        e.full_name.toLowerCase().includes(q) ||
        e.department?.toLowerCase().includes(q) ||
        e.designation?.toLowerCase().includes(q) ||
        e.email?.toLowerCase().includes(q)
      );
    }
    if (deptFilter !== "all") list = list.filter(e => e.department === deptFilter);
    return list;
  }, [employees, search, deptFilter]);

  // ── Provision helpers ──────────────────────────────────────────────────────

  async function doProvisionAll(employeeId: string): Promise<ProvisionResult | null> {
    const res = await fetch("/api/cosec/provision-employee-all-locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: employeeId }),
    });
    const data: ProvisionResult & { error?: string } = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Provisioning failed");
    return data;
  }

  function showProvisionResult(data: ProvisionResult, empName: string) {
    if (data.failed.length === 0) {
      toast.success(`${empName}: provisioned on ${data.provisioned} device(s)`);
    } else {
      const failedNames = data.failed.map(f => f.label).join(", ");
      toast.warning(
        `${empName}: ${data.provisioned} succeeded, ${data.failed.length} failed (${failedNames})`
      );
    }
  }

  // ── Create employee ────────────────────────────────────────────────────────

  async function handleCreate() {
    if (!form.full_name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: form.full_name.trim(),
          phone: form.phone || null,
          email: form.email || null,
          department: form.department || null,
          designation: form.designation || null,
          location_id: form.location_id || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create employee");

      toast.success(`${form.full_name} created`);
      setAddOpen(false);
      setForm({ full_name: "", phone: "", email: "", department: "", designation: "", location_id: "" });

      // Auto-provision after creating
      if (data.id) {
        toast.info("Provisioning on all COSEC devices…");
        try {
          const prov = await doProvisionAll(data.id);
          if (prov) {
            showProvisionResult(prov, form.full_name.trim());
            if (prov.failed.length > 0) {
              setProvisionFailures(prev => ({ ...prev, [data.id]: prov.failed }));
            }
          }
        } catch {
          toast.warning("Created but auto-provisioning failed. Use the Enroll button to retry.");
        }
      }

      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  // ── Provision on all locations ─────────────────────────────────────────────

  async function handleProvisionAll(emp: Employee) {
    setActionLoading(prev => ({ ...prev, [emp.id + "_provision"]: "loading" }));
    try {
      const prov = await doProvisionAll(emp.id);
      if (prov) {
        showProvisionResult(prov, emp.full_name);
        // Clear failures if all succeeded, update if some still failing
        setProvisionFailures(prev => {
          const next = { ...prev };
          if (prov.failed.length === 0) delete next[emp.id];
          else next[emp.id] = prov.failed;
          return next;
        });
      }
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Provisioning error");
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[emp.id + "_provision"]; return n; });
    }
  }

  // ── Card assignment ────────────────────────────────────────────────────────

  async function handleAssignCard() {
    if (!cardDialog || cardDialog.mode !== "assign") return;
    setCardScanning(true);
    try {
      const res = await fetch("/api/cosec/assign-employee-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: cardDialog.employee.id, scan_device_id: cardDialog.deviceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      toast.success(`Card ${data.cardNumber} assigned, active on ${data.propagatedToDevices} device(s)`);
      setCardDialog(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Card error");
    } finally {
      setCardScanning(false);
    }
  }

  async function handleUnassignCard() {
    if (!cardDialog || cardDialog.mode !== "unassign") return;
    setCardUnassigning(true);
    try {
      const res = await fetch("/api/cosec/unassign-employee-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: cardDialog.employee.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      toast.success(`Card unbound from ${data.unboundDevices} device(s). Card can now be reassigned.`);
      setCardDialog(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setCardUnassigning(false);
    }
  }

  // ── Block / restore everywhere ─────────────────────────────────────────────

  async function handleBlockAll(emp: Employee) {
    if (!confirm(`Block ${emp.full_name} on all devices and deactivate?`)) return;
    setActionLoading(prev => ({ ...prev, [emp.id + "_block"]: "loading" }));
    try {
      let blocked = 0;
      for (const enrollment of emp.enrollments) {
        if (enrollment.enrollment_status === "blocked") continue;
        const { data: au } = await supabase
          .from("cosec_access_users")
          .select("id")
          .eq("entity_id", emp.id)
          .eq("device_id", enrollment.device_id)
          .single();
        if (!au) continue;
        const res = await fetch("/api/cosec/block-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_user_id: au.id }),
        });
        if (res.ok) blocked++;
      }
      await supabase.from("employees").update({ is_active: false }).eq("id", emp.id);
      toast.success(`${emp.full_name} blocked on ${blocked} device(s) and deactivated`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[emp.id + "_block"]; return n; });
    }
  }

  async function handleRestoreAll(emp: Employee) {
    setActionLoading(prev => ({ ...prev, [emp.id + "_restore"]: "loading" }));
    try {
      let restored = 0;
      for (const enrollment of emp.enrollments) {
        if (enrollment.enrollment_status !== "blocked") continue;
        const { data: au } = await supabase
          .from("cosec_access_users")
          .select("id")
          .eq("entity_id", emp.id)
          .eq("device_id", enrollment.device_id)
          .single();
        if (!au) continue;
        const res = await fetch("/api/cosec/restore-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_user_id: au.id }),
        });
        if (res.ok) restored++;
      }
      await supabase.from("employees").update({ is_active: true }).eq("id", emp.id);
      toast.success(`${emp.full_name} restored on ${restored} device(s)`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[emp.id + "_restore"]; return n; });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <PageBreadcrumb resetTo={{ label: "Employees" }} />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Employees</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Staff with COSEC access across {totalDevices} entry point{totalDevices !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/attendance">
            <Button variant="outline" size="sm">
              <Fingerprint className="h-4 w-4 mr-2" />
              Attendance
            </Button>
          </Link>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add Employee
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total employees", value: employees.length, icon: Users },
          { label: "Active", value: employees.filter(e => e.is_active).length, icon: CheckCircle2 },
          { label: "Cards assigned", value: employees.filter(e => e.nfc_card_number).length, icon: CreditCard },
          {
            label: "Fully covered",
            value: employees.filter(e =>
              e.enrollments.filter(x => x.enrollment_status !== "blocked" && x.enrollment_status !== "deleted").length >= totalDevices
            ).length,
            icon: ShieldCheck,
          },
        ].map(s => (
          <Card key={s.label} className="p-0">
            <CardContent className="p-4 flex items-center gap-3">
              <s.icon className="h-5 w-5 text-muted-foreground shrink-0" />
              <div>
                <div className="text-lg font-semibold">{s.value}</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search employees…"
            className="pl-8"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Select value={deptFilter} onValueChange={setDeptFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" onClick={load}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Employee list */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">No employees found</div>
        )}
        {filtered.map(emp => {
          const isBlocked = emp.enrollments.every(e => e.enrollment_status === "blocked") && emp.enrollments.length > 0;
          const activeCount = emp.enrollments.filter(e => e.enrollment_status !== "blocked" && e.enrollment_status !== "deleted").length;
          const pendingCount = totalDevices - activeCount;
          const failures = provisionFailures[emp.id] ?? [];

          return (
            <Card key={emp.id} className={`border ${!emp.is_active ? "opacity-60" : ""}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {emp.is_crm_user ? (
                        <span className="font-medium">{emp.full_name}</span>
                      ) : (
                        <Link
                          href={`/admin/employees/${emp.id}`}
                          className="font-medium hover:underline"
                          onClick={() => {
                            pushTrailEntry({ href: `/admin/employees/${emp.id}`, label: emp.full_name });
                          }}
                        >
                          {emp.full_name}
                        </Link>
                      )}
                      {!emp.is_active && <Badge className="bg-gray-100 text-gray-500 text-xs">Inactive</Badge>}
                      {emp.is_crm_user && (
                        <Badge className="bg-blue-50 text-blue-700 border-blue-200 text-xs">CRM User</Badge>
                      )}
                      {emp.cosec_ref_id && (
                        <span className="text-xs text-muted-foreground font-mono">#{emp.cosec_ref_id}</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground mt-0.5">
                      {[emp.designation, emp.department, emp.location?.name].filter(Boolean).join(" · ")}
                    </div>
                    <div className="mt-2">
                      <EnrollmentBadge emp={emp} totalDevices={totalDevices} failedDevices={failures} />
                    </div>

                    {/* Per-device status pills */}
                    {emp.enrollments.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {emp.enrollments.map(e => {
                          const cfg = STATUS_CONFIG[e.enrollment_status] ?? STATUS_CONFIG.pending;
                          return (
                            <span key={e.device_id} className={`text-xs px-1.5 py-0.5 rounded border ${cfg.className}`}>
                              {e.location_name} — {e.device_label} · {cfg.label}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {/* Failed device names with retry */}
                    {failures.length > 0 && (
                      <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <div className="font-medium mb-1 flex items-center gap-1">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Provisioning failed on {failures.length} device{failures.length > 1 ? "s" : ""}:
                        </div>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {failures.map(f => (
                            <li key={f.device_id}>{f.label} — <span className="opacity-70">{f.error}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                    {emp.is_crm_user && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setForm(prev => ({ ...prev, full_name: emp.full_name, email: emp.email ?? "", phone: emp.phone ?? "" }));
                          setAddOpen(true);
                        }}
                        title="Create an employee record to enable COSEC enrollment"
                      >
                        <UserPlus className="h-3.5 w-3.5 mr-1" />
                        Add to COSEC
                      </Button>
                    )}
                    {!emp.is_crm_user && (pendingCount > 0 || failures.length > 0) && emp.is_active && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleProvisionAll(emp)}
                        disabled={!!actionLoading[emp.id + "_provision"]}
                        className={failures.length > 0 ? "border-amber-300 text-amber-700 hover:bg-amber-50" : ""}
                      >
                        {actionLoading[emp.id + "_provision"] ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                        ) : (
                          <MonitorSmartphone className="h-3.5 w-3.5 mr-1" />
                        )}
                        {failures.length > 0 ? "Retry failed" : `Enroll (${pendingCount} missing)`}
                      </Button>
                    )}

                    {!emp.is_crm_user && emp.enrollments.length > 0 && emp.is_active && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCardDialog({ employee: emp, mode: "assign", deviceId: devices[0]?.id ?? "" })}
                        >
                          <CreditCard className="h-3.5 w-3.5 mr-1" />
                          {emp.nfc_card_number ? "Reassign card" : "Assign card"}
                        </Button>
                        {emp.nfc_card_number && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-orange-600 hover:text-orange-700 border-orange-200 hover:bg-orange-50"
                            title={`Return card ${emp.nfc_card_number}`}
                            onClick={() => setCardDialog({ employee: emp, mode: "unassign", deviceId: "" })}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </>
                    )}

                    {!emp.is_crm_user && !isBlocked && emp.is_active && emp.enrollments.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50"
                        onClick={() => handleBlockAll(emp)}
                        disabled={!!actionLoading[emp.id + "_block"]}
                        title="Block on all devices"
                      >
                        {actionLoading[emp.id + "_block"] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                    {!emp.is_crm_user && (isBlocked || !emp.is_active) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-green-600 hover:text-green-700 border-green-200 hover:bg-green-50"
                        onClick={() => handleRestoreAll(emp)}
                        disabled={!!actionLoading[emp.id + "_restore"]}
                      >
                        {actionLoading[emp.id + "_restore"] ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
                        Restore
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Add employee dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Employee</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {[
              { key: "full_name", label: "Full name *", placeholder: "Ravi Kumar" },
              { key: "phone", label: "Phone", placeholder: "+91 98765 43210" },
              { key: "email", label: "Email", placeholder: "ravi@workville.in" },
              { key: "department", label: "Department", placeholder: "Operations" },
              { key: "designation", label: "Designation", placeholder: "Floor Manager" },
            ].map(f => (
              <div key={f.key} className="space-y-1">
                <Label className="text-sm">{f.label}</Label>
                <Input
                  placeholder={f.placeholder}
                  value={form[f.key as keyof typeof form]}
                  onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-sm">Home location</Label>
              <Select
                value={form.location_id || "none"}
                onValueChange={v => setForm(prev => ({ ...prev, location_id: v === "none" ? "" : v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {locations.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
              Create & Enroll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Card assign dialog */}
      {cardDialog?.mode === "assign" && (
        <Dialog open onOpenChange={() => { if (!cardScanning) setCardDialog(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {cardDialog.employee.nfc_card_number ? "Reassign" : "Assign"} NFC Card — {cardDialog.employee.full_name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                Select the device to scan on. Tap the card within 20 seconds.
                The card will be propagated to all enrolled devices.
              </p>
              {cardDialog.employee.nfc_card_number && (
                <div className="text-xs bg-amber-50 border border-amber-200 rounded px-3 py-2 text-amber-800">
                  Replacing current card: <span className="font-mono">{cardDialog.employee.nfc_card_number}</span>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-sm">Scan on device</Label>
                <Select
                  value={cardDialog.deviceId}
                  onValueChange={v => setCardDialog(d => d ? { ...d, deviceId: v } : null)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {devices.map(d => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.location?.name ?? ""} — {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {cardScanning && (
                <div className="flex items-center gap-2 text-blue-700 bg-blue-50 rounded px-3 py-2">
                  <Clock className="h-4 w-4 animate-pulse" />
                  <span className="text-sm">Waiting for card tap… (20 seconds)</span>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCardDialog(null)} disabled={cardScanning}>Cancel</Button>
              <Button onClick={handleAssignCard} disabled={cardScanning || !cardDialog.deviceId}>
                {cardScanning ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Scanning…</>
                ) : (
                  <><CreditCard className="h-4 w-4 mr-2" />Start scan</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Card return / unassign dialog */}
      {cardDialog?.mode === "unassign" && (
        <Dialog open onOpenChange={() => { if (!cardUnassigning) setCardDialog(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Return Card — {cardDialog.employee.full_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                This will remove the card binding from all COSEC devices and free the card
                to be reassigned to another employee.
              </p>
              <div className="text-sm bg-gray-50 border rounded px-3 py-2">
                Card: <span className="font-mono font-medium">{cardDialog.employee.nfc_card_number}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                The employee will still have PIN access on enrolled devices until fully offboarded.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCardDialog(null)} disabled={cardUnassigning}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={handleUnassignCard}
                disabled={cardUnassigning}
              >
                {cardUnassigning ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Removing…</>
                ) : (
                  <>Return card</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
