"use client";

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Upload,
  Loader2,
  CheckCircle,
  AlertTriangle,
  FileText,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { ServiceImportPreviewRow, ServiceUsageImport } from "@/types";

interface Location {
  id: string;
  name: string;
  code: string;
}

interface PrintReportUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
  locations: Location[];
  /** Pre-select a location */
  defaultLocationId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function rowFlag(row: ServiceImportPreviewRow) {
  if (row.flags?.includes("no_bw_quota") || row.flags?.includes("no_colour_quota")) {
    return "no_quota";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PreviewTable({
  rows,
  exclusions,
  onToggleExclude,
}: {
  rows: ServiceImportPreviewRow[];
  exclusions: Record<string, boolean>;
  onToggleExclude: (deptId: string) => void;
}) {
  return (
    <div className="rounded-md border overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-2 py-1.5 text-left font-medium w-5"></th>
            <th className="px-2 py-1.5 text-left font-medium">Dept ID</th>
            <th className="px-2 py-1.5 text-left font-medium">Customer</th>
            <th className="px-2 py-1.5 text-right font-medium">B&W used</th>
            <th className="px-2 py-1.5 text-right font-medium">B&W over</th>
            <th className="px-2 py-1.5 text-right font-medium">Colour used</th>
            <th className="px-2 py-1.5 text-right font-medium">Colour over</th>
            <th className="px-2 py-1.5 text-right font-medium">Amount</th>
            <th className="px-2 py-1.5 text-center font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const excluded = exclusions[row.dept_id];
            const flag     = rowFlag(row);
            return (
              <tr
                key={row.dept_id}
                className={[
                  "border-b last:border-0",
                  excluded        ? "opacity-40 bg-muted/20"   : "",
                  row.is_unmapped ? "bg-amber-50/60"           : "",
                ].join(" ")}
              >
                {/* Exclude toggle */}
                <td className="px-2 py-1.5">
                  {!row.is_unmapped && (
                    <button
                      type="button"
                      onClick={() => onToggleExclude(row.dept_id)}
                      className="text-muted-foreground hover:text-foreground"
                      title={excluded ? "Include row" : "Exclude row"}
                    >
                      {excluded ? (
                        <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono">{row.dept_id}</td>
                <td className="px-2 py-1.5">
                  {row.is_unmapped ? (
                    <span className="text-amber-700 italic text-xs">Unmapped</span>
                  ) : (
                    <div>
                      <div className="font-medium truncate max-w-[140px]">
                        {row.customer_name || "—"}
                      </div>
                      <div className="text-muted-foreground font-mono">
                        {row.contract_number}
                      </div>
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{row.bw_used}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {row.bw_overage_qty > 0 ? (
                    <span className="text-orange-600 font-medium">{row.bw_overage_qty}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{row.colour_used}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {row.colour_overage_qty > 0 ? (
                    <span className="text-orange-600 font-medium">{row.colour_overage_qty}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                  {row.total_amount > 0 ? formatCurrency(row.total_amount) : "—"}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {row.is_unmapped ? (
                    <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs">
                      Unmapped
                    </Badge>
                  ) : flag === "no_quota" ? (
                    <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 text-xs">
                      No quota
                    </Badge>
                  ) : excluded ? (
                    <Badge variant="secondary" className="text-xs">Excluded</Badge>
                  ) : row.total_amount > 0 ? (
                    <Badge variant="secondary" className="bg-orange-100 text-orange-800 text-xs">
                      Chargeable
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                      Within quota
                    </Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function PrintReportUploadDialog({
  open,
  onOpenChange,
  onConfirmed,
  locations,
  defaultLocationId,
}: PrintReportUploadDialogProps) {
  const { year: currentYear, month: currentMonth } = currentYearMonth();

  const [step,        setStep]        = useState<"upload" | "preview" | "done">("upload");
  const [locationId,  setLocationId]  = useState(defaultLocationId || locations[0]?.id || "");
  const [periodYear,  setPeriodYear]  = useState(currentYear);
  const [periodMonth, setPeriodMonth] = useState(currentMonth);
  const [file,        setFile]        = useState<File | null>(null);
  const [uploading,   setUploading]   = useState(false);
  const [confirming,  setConfirming]  = useState(false);
  const [importData,  setImportData]  = useState<ServiceUsageImport | null>(null);
  const [exclusions,  setExclusions]  = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleClose() {
    if (uploading || confirming) return;
    // Reset on close
    setStep("upload");
    setFile(null);
    setImportData(null);
    setExclusions({});
    onOpenChange(false);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] || null);
  }

  function toggleExclude(deptId: string) {
    setExclusions((prev) => ({ ...prev, [deptId]: !prev[deptId] }));
  }

  // Step 1: upload → preview
  async function handleUpload() {
    if (!file || !locationId || !periodYear || !periodMonth) {
      toast.error("Please fill in all fields and select a file");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file",         file);
      fd.append("location_id",  locationId);
      fd.append("period_year",  String(periodYear));
      fd.append("period_month", String(periodMonth));

      const res  = await fetch("/api/accounting/service-import", { method: "POST", body: fd });
      const json = await res.json();

      if (!res.ok) {
        toast.error(json.error || "Upload failed");
        return;
      }
      setImportData(json.data as ServiceUsageImport);
      setStep("preview");
    } catch {
      toast.error("Something went wrong during upload");
    } finally {
      setUploading(false);
    }
  }

  // Step 2: confirm
  async function handleConfirm() {
    if (!importData) return;
    setConfirming(true);
    try {
      const res  = await fetch(`/api/accounting/service-import/${importData.id}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ exclusions }),
      });
      const json = await res.json();

      if (!res.ok) {
        toast.error(json.error || "Confirmation failed");
        return;
      }

      const summary = json.summary as { service_records_created: number; usage_charges_created: number };
      toast.success(
        `Confirmed — ${summary.usage_charges_created} charge(s) created for ${summary.service_records_created} service record(s)`
      );
      setStep("done");
      onConfirmed();
    } catch {
      toast.error("Something went wrong during confirmation");
    } finally {
      setConfirming(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const previewRows = (importData?.preview_rows || []) as ServiceImportPreviewRow[];
  const chargeableRows = previewRows.filter(
    (r) => !r.is_unmapped && !exclusions[r.dept_id] && r.total_amount > 0
  );
  const totalChargeable = chargeableRows.reduce((s, r) => s + r.total_amount, 0);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Printer Usage Report</DialogTitle>
        </DialogHeader>

        {/* ── Step 1: Upload ───────────────────────────────────────────── */}
        {step === "upload" && (
          <div className="space-y-5 py-2">
            {/* Location */}
            <div className="space-y-1.5">
              <Label>Location</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name} ({loc.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Billing period */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Month</Label>
                <Select
                  value={String(periodMonth)}
                  onValueChange={(v) => setPeriodMonth(parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Year</Label>
                <Select
                  value={String(periodYear)}
                  onValueChange={(v) => setPeriodYear(parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* File picker */}
            <div className="space-y-1.5">
              <Label>Report File (.csv, .xlsx)</Label>
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? (
                  <div className="flex items-center justify-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-blue-600" />
                    <span className="font-medium">{file.name}</span>
                    <span className="text-muted-foreground">
                      ({(file.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Click to select or drag & drop a CSV / Excel report
                    </p>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          </div>
        )}

        {/* ── Step 2: Preview ──────────────────────────────────────────── */}
        {step === "preview" && importData && (
          <div className="space-y-4 py-2">
            {/* Summary bar */}
            <div className="grid grid-cols-4 gap-3">
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-0.5">Total rows</p>
                <p className="text-lg font-semibold">{importData.total_rows}</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-0.5">Mapped</p>
                <p className="text-lg font-semibold text-green-700">{importData.mapped_rows}</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-0.5">Unmapped</p>
                <p className={`text-lg font-semibold ${importData.unmapped_rows > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
                  {importData.unmapped_rows}
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-0.5">Chargeable (ex-GST)</p>
                <p className="text-lg font-semibold text-orange-600">
                  {formatCurrency(totalChargeable)}
                </p>
              </div>
            </div>

            {/* Unmapped warning */}
            {importData.unmapped_rows > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>
                  <strong>{importData.unmapped_rows} department ID{importData.unmapped_rows !== 1 ? "s" : ""}</strong>{" "}
                  could not be matched to an active contract. Assign Department IDs to contracts in their settings, then re-import.
                </p>
              </div>
            )}

            {/* Row table */}
            <PreviewTable
              rows={previewRows}
              exclusions={exclusions}
              onToggleExclude={toggleExclude}
            />

            <p className="text-xs text-muted-foreground">
              Click the × on any row to exclude it from this import. Excluded rows are skipped when you confirm.
            </p>
          </div>
        )}

        {/* ── Step 3: Done ─────────────────────────────────────────────── */}
        {step === "done" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <CheckCircle className="h-12 w-12 text-green-600" />
            <p className="text-lg font-semibold">Import confirmed</p>
            <p className="text-sm text-muted-foreground text-center">
              Overage charges have been posted to the relevant contracts and will
              appear on their next billing statement.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={uploading || confirming}>
            {step === "done" ? "Close" : "Cancel"}
          </Button>

          {step === "upload" && (
            <Button onClick={handleUpload} disabled={uploading || !file || !locationId}>
              {uploading ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Parsing…</>
              ) : (
                <><Upload className="mr-2 h-4 w-4" />Upload & Preview</>
              )}
            </Button>
          )}

          {step === "preview" && (
            <Button onClick={handleConfirm} disabled={confirming}>
              {confirming ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Confirming…</>
              ) : (
                <><CheckCircle className="mr-2 h-4 w-4" />Confirm & Post Charges</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
