"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  RefreshCw,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Users,
  CalendarDays,
  MapPin,
  Loader2,
  AlertCircle,
  Plus,
  X,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import Link from "next/link";
import { Label } from "@/components/ui/label";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DayEntry {
  date: string;
  first_in: string | null;
  last_out: string | null;
  entries: number;
  location_name: string;
}

interface EmployeeRow {
  entity_id: string;
  entity_name: string;
  department: string | null;
  designation: string | null;
  home_location: string | null;
  days_present: number;
  days: DayEntry[];
}

interface Location {
  id: string;
  name: string;
}

interface AttendanceCorrection {
  id: string;
  employee_id: string;
  correction_date: string;
  correction_type: string;
  corrected_time: string;
  reason: string | null;
  status: string;
  employee?: { full_name: string };
}

interface Employee {
  id: string;
  full_name: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthDates(year: number, month: number): string[] {
  const days: string[] = [];
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatShortDate(dateStr: string): string {
  const [, , d] = dateStr.split("-");
  return String(parseInt(d));
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr);
  const day = d.getDay();
  return day === 0 || day === 6;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const supabase = createClient();
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");

  // Detail drawer
  const [detail, setDetail] = useState<{ emp: EmployeeRow; date: string; day: DayEntry } | null>(null);

  // Corrections panel
  const [correctionsOpen, setCorrectionsOpen] = useState(false);
  const [corrections, setCorrections] = useState<AttendanceCorrection[]>([]);
  const [loadingCorrections, setLoadingCorrections] = useState(false);
  const [allEmployees, setAllEmployees] = useState<Employee[]>([]);
  const [corrForm, setCorrForm] = useState({
    employee_id: "",
    correction_date: today.toISOString().slice(0, 10),
    correction_type: "add_out",
    corrected_time: "",
    reason: "",
  });
  const [submittingCorr, setSubmittingCorr] = useState(false);

  const dates = useMemo(() => monthDates(year, month), [year, month]);
  const monthLabel = useMemo(() =>
    new Date(year, month, 1).toLocaleString("en-IN", { month: "long", year: "numeric" }),
    [year, month]
  );
  const workingDays = useMemo(() => dates.filter(d => !isWeekend(d)).length, [dates]);

  const load = useCallback(async () => {
    setLoading(true);
    const from = dates[0];
    const to   = dates[dates.length - 1];
    const params = new URLSearchParams({ type: "employee_register", from, to });
    if (locationFilter !== "all") params.set("location_id", locationFilter);
    if (deptFilter !== "all") params.set("department", deptFilter);

    try {
      const res = await fetch(`/api/cosec/analytics?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setEmployees(data.employees ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load attendance");
    } finally {
      setLoading(false);
    }
  }, [dates, locationFilter, deptFilter]);

  const loadCorrections = useCallback(async () => {
    setLoadingCorrections(true);
    const { data } = await supabase
      .from("attendance_corrections")
      .select("*, employee:employees!attendance_corrections_employee_id_fkey(full_name)")
      .order("created_at", { ascending: false })
      .limit(100);
    setCorrections((data ?? []) as AttendanceCorrection[]);
    setLoadingCorrections(false);
  }, [supabase]);

  useEffect(() => {
    supabase.from("locations").select("id, name").order("name").then(({ data }) => {
      setLocations(data ?? []);
    });
    supabase
      .from("employees")
      .select("id, full_name")
      .eq("is_active", true)
      .order("full_name")
      .then(({ data }) => {
        setAllEmployees((data ?? []) as Employee[]);
      });
    supabase
      .from("employees")
      .select("department")
      .eq("is_active", true)
      .not("department", "is", null)
      .then(({ data }) => {
        const d = new Set((data ?? []).map(e => e.department as string));
        setDepartments(Array.from(d).sort());
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitCorrection() {
    if (!corrForm.employee_id || !corrForm.corrected_time) {
      toast.error("Employee and corrected time are required");
      return;
    }
    setSubmittingCorr(true);
    // Build a proper ISO timestamp from date + time input (IST → UTC)
    const istDateTime = new Date(`${corrForm.correction_date}T${corrForm.corrected_time}:00+05:30`);
    const { error } = await supabase.from("attendance_corrections").insert({
      employee_id: corrForm.employee_id,
      correction_date: corrForm.correction_date,
      correction_type: corrForm.correction_type,
      corrected_time: istDateTime.toISOString(),
      reason: corrForm.reason || null,
      status: "pending",
    });
    setSubmittingCorr(false);
    if (error) { toast.error("Failed to submit correction"); return; }
    toast.success("Correction submitted — pending HR review");
    setCorrForm(f => ({ ...f, employee_id: "", corrected_time: "", reason: "" }));
    loadCorrections();
  }

  async function updateCorrectionStatus(id: string, status: "approved" | "rejected") {
    const { error } = await supabase
      .from("attendance_corrections")
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq("id", id);
    if (error) { toast.error("Failed to update"); return; }
    toast.success(`Correction ${status}`);
    loadCorrections();
  }

  useEffect(() => { load(); }, [load]);

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  const filtered = useMemo(() => {
    if (!search) return employees;
    const q = search.toLowerCase();
    return employees.filter(e =>
      e.entity_name.toLowerCase().includes(q) ||
      e.department?.toLowerCase().includes(q)
    );
  }, [employees, search]);

  function exportCsv() {
    function durationMins(first: string | null, last: string | null): string {
      if (!first || !last) return "";
      const mins = Math.round((new Date(last).getTime() - new Date(first).getTime()) / 60000);
      if (mins < 0) return "";
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const header = ["Employee", "Department", "Home Location", "Date", "First IN", "Last OUT", "Duration", "Location", "Status"];
    const rows: (string | number)[][] = [];

    for (const emp of filtered) {
      const dayMap = new Map(emp.days.map(d => [d.date, d]));
      for (const date of dates) {
        if (isWeekend(date)) {
          rows.push([emp.entity_name, emp.department ?? "", emp.home_location ?? "", date, "", "", "", "", "WO"]);
          continue;
        }
        const d = dayMap.get(date);
        if (d?.first_in) {
          rows.push([
            emp.entity_name,
            emp.department ?? "",
            emp.home_location ?? "",
            date,
            formatTime(d.first_in),
            formatTime(d.last_out),
            durationMins(d.first_in, d.last_out),
            d.location_name,
            "P",
          ]);
        } else {
          rows.push([emp.entity_name, emp.department ?? "", emp.home_location ?? "", date, "", "", "", "", "A"]);
        }
      }
    }

    const escape = (v: string | number) => {
      const s = String(v);
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows].map(r => r.map(escape).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `attendance_${year}_${String(month + 1).padStart(2, "0")}.csv`;
    a.click();
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Employee Attendance</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{monthLabel} · {workingDays} working days</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setCorrectionsOpen(true); loadCorrections(); }}
          >
            <AlertCircle className="h-4 w-4 mr-2" />
            Corrections
          </Button>
          <Link href="/admin/employees">
            <Button variant="outline" size="sm">
              <Users className="h-4 w-4 mr-2" />
              Manage employees
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={loading || filtered.length === 0}>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
          <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Month nav + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 border rounded-md">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium px-2 min-w-[140px] text-center">{monthLabel}</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={nextMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Select value={locationFilter} onValueChange={setLocationFilter}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <SelectValue placeholder="All locations" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={deptFilter} onValueChange={setDeptFilter}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="absolute left-2.5 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search…"
            className="pl-7 h-8 text-sm w-40"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Summary cards */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Employees", value: filtered.length, icon: Users },
            { label: "Working days", value: workingDays, icon: CalendarDays },
            { label: "Avg. present days", value: filtered.length ? Math.round(filtered.reduce((s, e) => s + e.days_present, 0) / filtered.length) : 0, icon: CheckCircle2 },
            { label: "Full attendance", value: filtered.filter(e => e.days_present >= workingDays).length, icon: CheckCircle2 },
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
      )}

      {/* Calendar grid */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">No employees found</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="text-xs min-w-full">
            <thead>
              <tr className="bg-muted/40 border-b">
                <th className="text-left px-3 py-2.5 font-medium min-w-[160px] sticky left-0 bg-muted/40 z-10">Employee</th>
                <th className="text-center px-2 py-2.5 font-medium min-w-[60px]">Present</th>
                {dates.map(d => (
                  <th
                    key={d}
                    className={`text-center px-1 py-2.5 font-medium min-w-[28px] ${isWeekend(d) ? "text-muted-foreground/50" : ""}`}
                    title={d}
                  >
                    {formatShortDate(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(emp => {
                const dayMap = new Map(emp.days.map(d => [d.date, d]));
                const attendance = emp.days_present / Math.max(workingDays, 1);

                return (
                  <tr key={emp.entity_id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 sticky left-0 bg-white z-10 border-r">
                      <div className="font-medium text-sm leading-tight">{emp.entity_name}</div>
                      <div className="text-muted-foreground text-xs">
                        {[emp.department, emp.home_location].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="text-center px-2 py-2">
                      <span className={`font-semibold ${attendance >= 0.9 ? "text-green-700" : attendance >= 0.7 ? "text-amber-600" : "text-red-600"}`}>
                        {emp.days_present}
                      </span>
                      <span className="text-muted-foreground">/{workingDays}</span>
                    </td>
                    {dates.map(date => {
                      const dayEntry = dayMap.get(date);
                      const weekend = isWeekend(date);

                      if (weekend) {
                        return (
                          <td key={date} className="text-center px-1 py-2 bg-muted/20">
                            <span className="text-muted-foreground/40 text-[10px]">W</span>
                          </td>
                        );
                      }

                      const present = !!dayEntry?.first_in;
                      // Future dates: no mark
                      const isPast = date <= today.toISOString().split("T")[0];

                      return (
                        <td
                          key={date}
                          className={`text-center px-1 py-2 cursor-pointer hover:bg-muted/30 ${present ? "bg-green-50" : isPast ? "bg-red-50/50" : ""}`}
                          onClick={() => dayEntry?.first_in && setDetail({ emp, date, day: dayEntry })}
                          title={present ? `${formatTime(dayEntry?.first_in ?? null)} – ${formatTime(dayEntry?.last_out ?? null)}` : isPast ? "Absent" : ""}
                        >
                          {present ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mx-auto" />
                          ) : isPast ? (
                            <XCircle className="h-3.5 w-3.5 text-red-400/60 mx-auto" />
                          ) : (
                            <span className="text-muted-foreground/20">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-600" /> Present</span>
        <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-400/60" /> Absent</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-muted/60 inline-block" /> Weekend</span>
        <span className="text-muted-foreground/60">Click a present cell for details</span>
      </div>

      {/* Corrections panel */}
      {correctionsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-start justify-end"
          onClick={() => setCorrectionsOpen(false)}
        >
          <div
            className="w-full max-w-lg h-full bg-background border-l shadow-xl flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Panel header */}
            <div className="flex items-center justify-between p-4 border-b flex-none">
              <div>
                <h2 className="font-semibold">Attendance Corrections</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Submit and review attendance corrections</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setCorrectionsOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* Submit form */}
              <div className="p-4 border-b bg-muted/20">
                <p className="text-sm font-medium mb-3 flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5" /> New Correction
                </p>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs">Employee</Label>
                    <Select value={corrForm.employee_id} onValueChange={v => setCorrForm(f => ({ ...f, employee_id: v }))}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select employee" />
                      </SelectTrigger>
                      <SelectContent>
                        {allEmployees.map(e => (
                          <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Date</Label>
                      <Input
                        type="date"
                        className="h-8 text-sm"
                        value={corrForm.correction_date}
                        onChange={e => setCorrForm(f => ({ ...f, correction_date: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Type</Label>
                      <Select value={corrForm.correction_type} onValueChange={v => setCorrForm(f => ({ ...f, correction_type: v }))}>
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="add_in">Add check-in</SelectItem>
                          <SelectItem value="add_out">Add check-out</SelectItem>
                          <SelectItem value="override_time">Override time</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Corrected Time (IST)</Label>
                    <Input
                      type="time"
                      className="h-8 text-sm"
                      value={corrForm.corrected_time}
                      onChange={e => setCorrForm(f => ({ ...f, corrected_time: e.target.value }))}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Reason</Label>
                    <Input
                      placeholder="Brief reason for correction"
                      className="h-8 text-sm"
                      value={corrForm.reason}
                      onChange={e => setCorrForm(f => ({ ...f, reason: e.target.value }))}
                    />
                  </div>
                  <Button size="sm" className="w-full" onClick={submitCorrection} disabled={submittingCorr}>
                    {submittingCorr ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                    Submit Correction
                  </Button>
                </div>
              </div>

              {/* Pending / recent list */}
              <div className="p-4">
                <p className="text-sm font-medium mb-3">Recent Corrections</p>
                {loadingCorrections ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : corrections.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No corrections yet</p>
                ) : (
                  <div className="space-y-2">
                    {corrections.map(c => (
                      <div key={c.id} className="border rounded-lg p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{c.employee?.full_name ?? "—"}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(c.correction_date)} · {c.correction_type.replace(/_/g, " ")}
                            </p>
                            {c.reason && <p className="text-xs text-muted-foreground mt-0.5 italic">{c.reason}</p>}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {c.status === "pending" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2 text-green-700 border-green-300"
                                  onClick={() => updateCorrectionStatus(c.id, "approved")}
                                >Approve</Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2 text-red-600 border-red-300"
                                  onClick={() => updateCorrectionStatus(c.id, "rejected")}
                                >Reject</Button>
                              </>
                            )}
                            {c.status !== "pending" && (
                              <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                                c.status === "approved" ? "bg-green-50 text-green-700 border-green-200" :
                                c.status === "applied"  ? "bg-blue-50 text-blue-700 border-blue-200" :
                                "bg-red-50 text-red-600 border-red-200"
                              }`}>
                                {c.status}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {detail && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center p-4"
          onClick={() => setDetail(null)}
        >
          <Card className="w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {detail.emp.entity_name}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {formatDate(detail.date)}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-50 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground mb-1">First in</div>
                  <div className="font-semibold text-green-700">{formatTime(detail.day.first_in)}</div>
                </div>
                <div className="bg-orange-50 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground mb-1">Last out</div>
                  <div className="font-semibold text-orange-700">{formatTime(detail.day.last_out)}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span>{detail.day.location_name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span>{detail.day.entries} access event{detail.day.entries !== 1 ? "s" : ""}</span>
              </div>
              <Button variant="outline" className="w-full" onClick={() => setDetail(null)}>Close</Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
