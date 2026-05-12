"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  AlertCircle, CheckCircle, CreditCard, ExternalLink,
  FileText, ChevronDown, ChevronUp, Calendar, Download, BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────
type TdsEntry = {
  id: string;
  bill_id: string;
  section_code: string;
  vendor_type: string;
  base_amount: number;
  tds_rate: number;
  tds_amount: number;
  pan_available: boolean;
  status: "pending" | "deposited";
  challan_id: string | null;
  period_month: number;
  period_year: number;
  created_at: string;
  bill: {
    bill_number: string;
    total_amount: number;
    invoice_number: string | null;
    invoice_date: string;
    vendor: { id: string; name: string; pan_number: string | null } | null;
  } | null;
  challan: {
    id: string; challan_ref: string; bsr_code: string;
    challan_serial: string; deposit_date: string;
  } | null;
  section: { code: string; description: string } | null;
};

type GroupKey = { year: number; month: number };
type SectionGroup = { sectionCode: string; sectionDesc: string; entries: TdsEntry[]; total: number };
type MonthGroup = { year: number; month: number; sections: SectionGroup[]; total: number; status: "pending" | "deposited" | "mixed" };

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function depositDueDate(month: number, year: number): string {
  // TDS due 7th of following month; April (month 4) is 30th April
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const day = month === 3 ? 30 : 7; // March (FY end) → 30 April
  return `${day} ${MONTH_NAMES[nextMonth - 1]} ${nextYear}`;
}

function isOverdue(month: number, year: number): boolean {
  const today = new Date();
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const day = month === 3 ? 30 : 7;
  const due = new Date(nextYear, nextMonth - 1, day);
  return today > due;
}

function groupEntries(entries: TdsEntry[]): MonthGroup[] {
  const monthMap = new Map<string, { key: GroupKey; sections: Map<string, SectionGroup> }>();

  for (const e of entries) {
    const mk = `${e.period_year}-${e.period_month}`;
    if (!monthMap.has(mk)) {
      monthMap.set(mk, { key: { year: e.period_year, month: e.period_month }, sections: new Map() });
    }
    const mGroup = monthMap.get(mk)!;
    const sk = e.section_code;
    if (!mGroup.sections.has(sk)) {
      mGroup.sections.set(sk, {
        sectionCode: sk,
        sectionDesc: e.section?.description ?? sk,
        entries: [],
        total: 0,
      });
    }
    const sg = mGroup.sections.get(sk)!;
    sg.entries.push(e);
    sg.total += Number(e.tds_amount);
  }

  return Array.from(monthMap.values()).map(({ key, sections }) => {
    const allSections = Array.from(sections.values());
    const total = allSections.reduce((s, sg) => s + sg.total, 0);
    const allDeposited = allSections.every((sg) => sg.entries.every((e) => e.status === "deposited"));
    const allPending = allSections.every((sg) => sg.entries.every((e) => e.status === "pending"));
    return {
      ...key,
      sections: allSections,
      total,
      status: allDeposited ? "deposited" : allPending ? "pending" : "mixed",
    };
  });
}

// ── Record Challan Dialog ─────────────────────────────────────
function RecordChallanDialog({
  open,
  onClose,
  month,
  year,
  sectionCode,
  sectionDesc,
  entries,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  month: number;
  year: number;
  sectionCode: string;
  sectionDesc: string;
  entries: TdsEntry[];
  onSaved: () => void;
}) {
  const [bsr, setBsr] = useState("");
  const [serial, setSerial] = useState("");
  const [depositDate, setDepositDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const total = entries.reduce((s, e) => s + Number(e.tds_amount), 0);

  async function handleSave() {
    if (!bsr || bsr.length !== 7) { toast.error("BSR code must be exactly 7 digits"); return; }
    if (!serial) { toast.error("Enter challan serial number"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/tds/challans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bsr_code: bsr,
          challan_serial: serial,
          deposit_date: depositDate,
          period_month: month,
          period_year: year,
          section_code: sectionCode,
          total_amount: total,
          tds_entry_ids: entries.map((e) => e.id),
          notes: notes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Failed to record challan"); return; }
      toast.success(`Challan ${data.data.challan_ref} recorded`);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-blue-600" />
            Record TDS Challan
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {sectionCode} — {sectionDesc} · {MONTH_NAMES[month - 1]} {year}
          </p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm">
            <p className="text-blue-700 text-xs mb-1">Total TDS to deposit (ITNS 281)</p>
            <p className="text-xl font-bold text-blue-900">{formatCurrency(total)}</p>
            <p className="text-xs text-blue-600 mt-0.5">{entries.length} deduction{entries.length !== 1 ? "s" : ""} covered</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">BSR Code (7 digits) *</Label>
              <Input
                value={bsr}
                onChange={(e) => setBsr(e.target.value.replace(/\D/g, "").slice(0, 7))}
                placeholder="0011234"
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Challan Serial *</Label>
              <Input
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="00123"
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Deposit Date *</Label>
              <Input
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Notes (optional)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. online payment via HDFC"
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Covering deductions</p>
            {entries.map((e) => (
              <div key={e.id} className="flex items-center justify-between text-xs py-1 border-b last:border-0">
                <div>
                  <span className="font-medium">{e.bill?.bill_number ?? "—"}</span>
                  <span className="text-muted-foreground ml-1.5">{e.bill?.vendor?.name ?? "—"}</span>
                </div>
                <span className="font-semibold text-blue-800">{formatCurrency(Number(e.tds_amount))}</span>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? "Recording…" : "Record Challan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── TDS Compliance Guide ──────────────────────────────────────
function TdsGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/40">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-blue-900 hover:bg-blue-50 transition-colors rounded-lg"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-blue-600" />
          TDS Compliance Guide — How to use this module
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-blue-500" /> : <ChevronDown className="h-4 w-4 text-blue-500" />}
      </button>

      {open && (
        <div className="px-4 pb-4 text-xs space-y-4 text-blue-900">
          <div className="grid md:grid-cols-2 gap-4">

            {/* What is TDS */}
            <div className="space-y-1.5">
              <p className="font-semibold text-sm">What is TDS?</p>
              <p className="text-blue-800 leading-relaxed">
                Tax Deducted at Source (TDS) is a mechanism where the payer deducts tax before making a payment to the vendor.
                The deducted amount is deposited to the Income Tax department on behalf of the vendor. The vendor then claims
                this as advance tax paid when filing their returns.
              </p>
            </div>

            {/* Applicable sections */}
            <div className="space-y-1.5">
              <p className="font-semibold text-sm">Applicable Sections</p>
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="bg-blue-100">
                    <th className="text-left px-2 py-1 font-semibold">Section</th>
                    <th className="text-left px-2 py-1 font-semibold">Nature</th>
                    <th className="text-right px-2 py-1 font-semibold">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100">
                  {[
                    ["194C", "Contractors / Sub-contractors", "1% (Ind) / 2% (Co)"],
                    ["194J(a)", "Technical Services", "2%"],
                    ["194J(b)", "Professional Services", "10%"],
                    ["194I(a)", "Rent – Plant & Machinery", "2%"],
                    ["194I(b)", "Rent – Land / Building", "10%"],
                    ["194H", "Commission & Brokerage", "5%"],
                  ].map(([sec, nat, rate]) => (
                    <tr key={sec} className="even:bg-blue-50/60">
                      <td className="px-2 py-1 font-mono font-medium">{sec}</td>
                      <td className="px-2 py-1">{nat}</td>
                      <td className="px-2 py-1 text-right">{rate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] text-blue-600">
                Section 206AA: If PAN is not available, rate is 20% regardless of section.
              </p>
            </div>

            {/* Monthly workflow */}
            <div className="space-y-1.5">
              <p className="font-semibold text-sm">Monthly Workflow</p>
              <ol className="list-decimal list-inside space-y-1.5 text-blue-800">
                <li><strong>At payment time</strong> — enable TDS deduction in the payment dialog. Enter the pre-GST base amount. The system calculates TDS and net-to-vendor amounts.</li>
                <li><strong>TDS Payable ledger</strong> — all deductions appear here grouped by month and section.</li>
                <li><strong>Deposit to IT Dept</strong> — pay via ITNS 281 challan at your bank (online or branch). Due by the <strong>7th of the following month</strong> (March due by 30th April).</li>
                <li><strong>Record Challan</strong> — enter the BSR code, challan serial, and deposit date in this module. This marks the TDS as deposited.</li>
              </ol>
            </div>

            {/* Quarterly compliance */}
            <div className="space-y-1.5">
              <p className="font-semibold text-sm">Quarterly Compliance (26Q)</p>
              <ol className="list-decimal list-inside space-y-1.5 text-blue-800">
                <li><strong>Download 26Q CSV</strong> from the Reports panel below for the relevant quarter.</li>
                <li>File 26Q on TRACES (www.tdscpc.gov.in) before the due date.</li>
                <li>After acceptance, <strong>download Form 16A</strong> from TRACES for each vendor, or generate our in-system version for interim records.</li>
                <li>Issue Form 16A to each vendor within 15 days of the 26Q due date.</li>
              </ol>
              <div className="bg-blue-100 border border-blue-200 rounded px-2 py-1.5 text-[11px] space-y-0.5">
                <p className="font-semibold">26Q Filing deadlines</p>
                <p>Q1 (Apr–Jun) → 31 Jul &nbsp;|&nbsp; Q2 (Jul–Sep) → 31 Oct</p>
                <p>Q3 (Oct–Dec) → 31 Jan &nbsp;|&nbsp; Q4 (Jan–Mar) → 31 May</p>
              </div>
            </div>

            {/* Key rules */}
            <div className="space-y-1.5">
              <p className="font-semibold text-sm">Key Rules to Remember</p>
              <ul className="list-disc list-inside space-y-1 text-blue-800">
                <li>TDS is on the <strong>pre-GST (base) amount</strong> — never on the GST portion.</li>
                <li>Late deposit attracts interest at <strong>1.5% per month</strong> (Section 201(1A)).</li>
                <li>Late filing of 26Q attracts <strong>₹200 per day</strong> fee (Section 234E).</li>
                <li>Short deduction is treated as deemed default — the company is liable for the shortfall.</li>
                <li>PAN of vendor is mandatory. Without PAN, deduct at <strong>20%</strong> (S.206AA).</li>
                <li>Form 16A must be issued within <strong>15 days</strong> of the quarterly 26Q due date.</li>
              </ul>
            </div>

            {/* TAN details */}
            <div className="space-y-1.5">
              <p className="font-semibold text-sm">Our TAN Details</p>
              <div className="bg-white border border-blue-200 rounded px-3 py-2 space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted-foreground">TAN</span>
                  <span className="font-mono font-semibold">CHEU00102E</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted-foreground">Entity</span>
                  <span className="font-medium">Sree Design Infrastructure Pvt Ltd</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted-foreground">Filing type</span>
                  <span>26Q — Non-Salary Deductions</span>
                </div>
              </div>
              <p className="text-[10px] text-blue-600">
                Use ITNS 281 challan code 0020 (companies) or 0021 (non-companies) when depositing.
              </p>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ── Quarter helpers ───────────────────────────────────────────
const QUARTERS = [
  { value: "1", label: "Q1 (Apr–Jun)" },
  { value: "2", label: "Q2 (Jul–Sep)" },
  { value: "3", label: "Q3 (Oct–Dec)" },
  { value: "4", label: "Q4 (Jan–Mar)" },
];

function currentFyYear() {
  const d = new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

function currentQuarter() {
  const m = new Date().getMonth() + 1;
  if (m >= 4 && m <= 6) return "1";
  if (m >= 7 && m <= 9) return "2";
  if (m >= 10 && m <= 12) return "3";
  return "4";
}

// ── Reports Panel ─────────────────────────────────────────────
function ReportsPanel() {
  const [quarter, setQuarter] = useState(currentQuarter());
  const [year, setYear] = useState(String(currentFyYear()));
  const [vendors, setVendors] = useState<{ id: string; name: string; pan_number: string | null }[]>([]);
  const [vendorId, setVendorId] = useState<string>("");
  const [generating16A, setGenerating16A] = useState(false);
  const [generating26Q, setGenerating26Q] = useState(false);

  useEffect(() => {
    fetch("/api/tds/payable?status=deposited")
      .then((r) => r.json())
      .then((json) => {
        const seen = new Map<string, { id: string; name: string; pan_number: string | null }>();
        for (const e of json.data ?? []) {
          const v = e.bill?.vendor;
          if (v && !seen.has(v.id)) seen.set(v.id, v);
        }
        setVendors(Array.from(seen.values()));
      });
  }, []);

  async function generateForm16A() {
    if (!vendorId) { toast.error("Select a vendor"); return; }
    setGenerating16A(true);
    try {
      const res = await fetch(`/api/tds/form16a?vendor_id=${vendorId}&quarter=${quarter}&year=${year}`);
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to fetch Form 16A data"); return; }

      const { jsPDF } = await import("jspdf");
      const d = json.data;
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const pageW = 210;
      let y = 15;

      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text("FORM 16A — TDS CERTIFICATE", pageW / 2, y, { align: "center" });
      y += 7;
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(`FY ${d.fy} · ${d.quarter}`, pageW / 2, y, { align: "center" });
      y += 10;

      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.text("DEDUCTOR (PAYER)", 15, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.text(`Name: ${d.deductor.name}`, 15, y); y += 4;
      doc.text(`TAN: ${d.deductor.tan}`, 15, y); y += 4;
      doc.text(`PAN: ${d.deductor.pan || "—"}`, 15, y); y += 8;

      doc.setFont("helvetica", "bold");
      doc.text("DEDUCTEE (PAYEE / VENDOR)", 15, y); y += 5;
      doc.setFont("helvetica", "normal");
      doc.text(`Name: ${d.deductee.name}`, 15, y); y += 4;
      doc.text(`PAN: ${d.deductee.pan || "PANNOTAVBL"}`, 15, y); y += 8;

      // Table header
      const cols = [15, 40, 68, 90, 112, 135, 158, 185];
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.text("Bill No.", cols[0], y);
      doc.text("Inv Date", cols[1], y);
      doc.text("Section", cols[2], y);
      doc.text("Base Amt", cols[3], y);
      doc.text("Rate%", cols[4], y);
      doc.text("TDS Amt", cols[5], y);
      doc.text("BSR/Challan", cols[6], y);
      doc.text("Deposit Dt", cols[7], y);
      y += 1;
      doc.line(15, y, 200, y);
      y += 4;

      doc.setFont("helvetica", "normal");
      for (const e of d.entries) {
        doc.text(String(e.bill_number), cols[0], y);
        doc.text(e.invoice_date ? formatDate(e.invoice_date) : "—", cols[1], y);
        doc.text(e.section_code, cols[2], y);
        doc.text(formatCurrency(e.base_amount), cols[3], y);
        doc.text(`${e.tds_rate}%`, cols[4], y);
        doc.text(formatCurrency(e.tds_amount), cols[5], y);
        doc.text(e.bsr_code ? `${e.bsr_code}/${e.challan_serial}` : "—", cols[6], y);
        doc.text(e.deposit_date ? formatDate(e.deposit_date) : "—", cols[7], y);
        y += 5;
        if (y > 270) { doc.addPage(); y = 20; }
      }

      y += 2;
      doc.line(15, y, 200, y);
      y += 6;
      doc.setFont("helvetica", "bold");
      doc.text("Total Amount Paid:", cols[3], y);
      doc.text(formatCurrency(d.totals.total_paid), cols[5], y);
      y += 5;
      doc.text("Total TDS Deducted:", cols[3], y);
      doc.text(formatCurrency(d.totals.total_tds), cols[5], y);

      const vendorName = vendors.find((v) => v.id === vendorId)?.name ?? "vendor";
      doc.save(`Form16A_${vendorName.replace(/\s+/g, "_")}_Q${quarter}_FY${year}.pdf`);
      toast.success("Form 16A PDF downloaded");
    } finally {
      setGenerating16A(false);
    }
  }

  async function export26Q() {
    setGenerating26Q(true);
    try {
      const res = await fetch(`/api/tds/26q?quarter=${quarter}&year=${year}`);
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to fetch 26Q data"); return; }

      const rows: Record<string, string | number>[] = json.data;
      if (rows.length === 0) { toast.info("No deposited TDS entries for this quarter"); return; }

      const headers = [
        "Deductor TAN", "Deductor Name", "Deductor PAN", "FY", "Quarter",
        "Deductee PAN", "Deductee Name", "Bill Number", "Invoice Date",
        "Section", "Amount Paid", "TDS Rate", "TDS Deducted",
        "Challan BSR", "Challan Serial", "Deposit Date", "Period Month", "Period Year",
      ];
      const keys = [
        "deductor_tan","deductor_name","deductor_pan","fy","quarter",
        "deductee_pan","deductee_name","bill_number","invoice_date",
        "section","amount_paid","tds_rate","tds_deducted",
        "challan_bsr","challan_serial","deposit_date","period_month","period_year",
      ];

      const csv = [headers.join(",")]
        .concat(rows.map((r) => keys.map((k) => `"${String(r[k] ?? "").replace(/"/g, '""')}"`).join(",")))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `26Q_Q${quarter}_FY${year}-${String(Number(year)+1).slice(2)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`26Q export — ${rows.length} rows downloaded`);
    } finally {
      setGenerating26Q(false);
    }
  }

  const fyYears = [currentFyYear() - 1, currentFyYear(), currentFyYear() + 1];

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Download className="h-4 w-4 text-blue-600" />
          Reports &amp; Exports
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">Form 16A (vendor certificate) and 26Q (quarterly return data)</p>
      </div>

      {/* Quarter / Year selectors */}
      <div className="flex gap-3 flex-wrap">
        <div className="space-y-1 w-36">
          <Label className="text-xs">Quarter</Label>
          <Select value={quarter} onValueChange={setQuarter}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {QUARTERS.map((q) => (
                <SelectItem key={q.value} value={q.value} className="text-xs">{q.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 w-28">
          <Label className="text-xs">FY Start Year</Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fyYears.map((y) => (
                <SelectItem key={y} value={String(y)} className="text-xs">{y}–{String(y+1).slice(2)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Form 16A */}
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-2">
          <div>
            <p className="text-sm font-medium">Form 16A — Vendor TDS Certificate</p>
            <p className="text-xs text-muted-foreground">PDF for a specific vendor for the selected quarter</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select vendor…" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id} className="text-xs">
                    {v.name}{!v.pan_number ? " (No PAN)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            className="w-full gap-2"
            onClick={generateForm16A}
            disabled={generating16A || !vendorId}
          >
            <FileText className="h-3.5 w-3.5" />
            {generating16A ? "Generating…" : "Download Form 16A PDF"}
          </Button>
        </div>

        {/* 26Q export */}
        <div className="rounded-lg border border-green-200 bg-green-50/40 p-3 space-y-2">
          <div>
            <p className="text-sm font-medium">26Q — Quarterly Return Data</p>
            <p className="text-xs text-muted-foreground">CSV with all deductee rows for TRACES upload / in-house filing</p>
          </div>
          <div className="rounded bg-green-100 border border-green-200 px-2 py-1.5 text-xs text-green-800 space-y-0.5">
            <p className="font-medium">Filing deadlines</p>
            <p>Q1 (Apr–Jun) → 31 Jul · Q2 (Jul–Sep) → 31 Oct</p>
            <p>Q3 (Oct–Dec) → 31 Jan · Q4 (Jan–Mar) → 31 May</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-2 border-green-400 text-green-800 hover:bg-green-50"
            onClick={export26Q}
            disabled={generating26Q}
          >
            <Download className="h-3.5 w-3.5" />
            {generating26Q ? "Exporting…" : "Download 26Q CSV"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export default function TdsPayablePage() {
  const [entries, setEntries] = useState<TdsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"pending" | "deposited" | "all">("pending");
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [challanDialog, setChallanDialog] = useState<{
    month: number; year: number; sectionCode: string; sectionDesc: string; entries: TdsEntry[];
  } | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/tds/payable?status=${statusFilter}`);
    const json = await res.json();
    if (res.ok) {
      setEntries(json.data ?? []);
      // Auto-expand all pending months
      if (statusFilter === "pending") {
        const keys = new Set<string>();
        (json.data ?? []).forEach((e: TdsEntry) => keys.add(`${e.period_year}-${e.period_month}`));
        setExpandedMonths(keys);
      }
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const groups = groupEntries(entries);
  const totalPending = entries.filter((e) => e.status === "pending").reduce((s, e) => s + Number(e.tds_amount), 0);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5 text-blue-600" />
            TDS Payable
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Tax deducted at source — challan register & Form 16A
          </p>
        </div>
        {totalPending > 0 && (
          <div className="text-right shrink-0">
            <p className="text-xs text-muted-foreground">Pending deposit</p>
            <p className="text-lg font-bold text-blue-700">{formatCurrency(totalPending)}</p>
          </div>
        )}
      </div>

      {/* Compliance guide */}
      <TdsGuide />

      {/* Compliance strip */}
      {totalPending > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 flex items-center gap-2.5 text-sm">
          <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-medium text-amber-900">
              {formatCurrency(totalPending)} TDS pending deposit
            </span>
            <span className="text-amber-700 ml-1.5 text-xs">
              — must be deposited by 7th of the following month via ITNS 281 challan
            </span>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(["pending", "deposited", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === s
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {s === "all" ? "All" : s === "pending" ? "Pending" : "Deposited"}
          </button>
        ))}
      </div>

      {/* Groups */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="animate-pulse bg-muted rounded-lg h-16" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-400" />
          <p className="font-medium">No {statusFilter === "all" ? "" : statusFilter} TDS entries</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((mg) => {
            const mk = `${mg.year}-${mg.month}`;
            const expanded = expandedMonths.has(mk);
            const overdue = mg.status === "pending" && isOverdue(mg.month, mg.year);

            return (
              <div key={mk} className={`rounded-lg border ${overdue ? "border-red-300" : "border-border"}`}>
                {/* Month header */}
                <button
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors rounded-t-lg"
                  onClick={() => setExpandedMonths((prev) => {
                    const next = new Set(prev);
                    next.has(mk) ? next.delete(mk) : next.add(mk);
                    return next;
                  })}
                >
                  <div className="flex items-center gap-3">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <div className="text-left">
                      <span className="font-semibold">{MONTH_NAMES[mg.month - 1]} {mg.year}</span>
                      {mg.status === "pending" && (
                        <span className={`ml-2 text-xs ${overdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                          {overdue ? "⚠ Overdue — " : "Due "}
                          {depositDueDate(mg.month, mg.year)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-blue-800">{formatCurrency(mg.total)}</span>
                    <Badge className={`text-[10px] border-0 ${
                      mg.status === "deposited" ? "bg-green-100 text-green-800" :
                      mg.status === "pending" ? "bg-amber-100 text-amber-800" :
                      "bg-gray-100 text-gray-700"
                    }`}>
                      {mg.status}
                    </Badge>
                    {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </button>

                {/* Section groups */}
                {expanded && (
                  <div className="border-t">
                    {mg.sections.map((sg) => {
                      const sectionPending = sg.entries.filter((e) => e.status === "pending");
                      return (
                        <div key={sg.sectionCode} className="border-b last:border-0">
                          {/* Section sub-header */}
                          <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20">
                            <div>
                              <span className="text-xs font-semibold text-blue-800">{sg.sectionCode.replace("_", "(")}{sg.sectionCode.includes("_") ? ")" : ""}</span>
                              <span className="text-xs text-muted-foreground ml-1.5">— {sg.sectionDesc}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold">{formatCurrency(sg.total)}</span>
                              {sectionPending.length > 0 && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2 border-blue-300 text-blue-700 hover:bg-blue-50"
                                  onClick={() => setChallanDialog({
                                    month: mg.month, year: mg.year,
                                    sectionCode: sg.sectionCode,
                                    sectionDesc: sg.sectionDesc,
                                    entries: sectionPending,
                                  })}
                                >
                                  Record Challan
                                </Button>
                              )}
                            </div>
                          </div>

                          {/* Entries */}
                          {sg.entries.map((e) => (
                            <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0 hover:bg-muted/10">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <Link
                                    href={`/accounting/vendor-payments/${e.bill_id}`}
                                    className="text-sm font-medium text-primary hover:underline flex items-center gap-1"
                                  >
                                    {e.bill?.bill_number ?? "—"}
                                    <ExternalLink className="h-3 w-3" />
                                  </Link>
                                  <span className="text-xs text-muted-foreground">{e.bill?.vendor?.name ?? "—"}</span>
                                  {!e.pan_available && (
                                    <span className="text-[10px] bg-red-100 text-red-700 px-1 rounded">No PAN</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                                  <span>Base: {formatCurrency(Number(e.base_amount))}</span>
                                  <span>Rate: {e.tds_rate}%</span>
                                  {e.bill?.invoice_date && <span>{formatDate(e.bill.invoice_date)}</span>}
                                </div>
                                {e.status === "deposited" && e.challan && (
                                  <p className="text-xs text-green-700 mt-0.5">
                                    ✓ Challan {e.challan.challan_ref} · BSR {e.challan.bsr_code} · {formatDate(e.challan.deposit_date)}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-semibold text-blue-800">{formatCurrency(Number(e.tds_amount))}</p>
                                <Badge className={`text-[10px] border-0 mt-0.5 ${
                                  e.status === "deposited" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
                                }`}>
                                  {e.status}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Reports panel */}
      <ReportsPanel />

      {/* Record Challan Dialog */}
      {challanDialog && (
        <RecordChallanDialog
          open
          onClose={() => setChallanDialog(null)}
          month={challanDialog.month}
          year={challanDialog.year}
          sectionCode={challanDialog.sectionCode}
          sectionDesc={challanDialog.sectionDesc}
          entries={challanDialog.entries}
          onSaved={fetchEntries}
        />
      )}
    </div>
  );
}
