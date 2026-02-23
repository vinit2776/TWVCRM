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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Loader2,
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import Papa from "papaparse";

interface ImportLeadsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface ImportResult {
  total: number;
  imported: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  warnings: string[];
}

type Step = "upload" | "preview" | "result";

export function ImportLeadsDialog({
  open,
  onOpenChange,
  onSuccess,
}: ImportLeadsDialogProps) {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setStep("upload");
    setFile(null);
    setPreviewRows([]);
    setPreviewHeaders([]);
    setTotalRows(0);
    setResult(null);
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileSelect = (selectedFile: File) => {
    if (!selectedFile.name.toLowerCase().endsWith(".csv")) {
      setError("Only CSV files are supported");
      return;
    }
    if (selectedFile.size > 10 * 1024 * 1024) {
      setError("File too large. Maximum 10MB.");
      return;
    }

    setFile(selectedFile);
    setError("");

    // Parse for preview
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        preview: 6, // 5 data rows + buffer
        transformHeader: (h) => h.trim(),
      });

      if (parsed.data.length === 0) {
        setError("CSV file appears to be empty");
        return;
      }

      // Count total rows (full parse just for count)
      const fullParsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });

      setPreviewHeaders(parsed.meta.fields || []);
      setPreviewRows(parsed.data.slice(0, 5));
      setTotalRows(fullParsed.data.length);
      setStep("preview");
    };
    reader.readAsText(selectedFile);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFileSelect(f);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileSelect(f);
  };

  const handleImport = async () => {
    if (!file) return;
    setSubmitting(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/leads/import", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      setResult(data);
      setStep("result");

      if (data.imported > 0) {
        toast.success(`${data.imported} leads imported successfully`);
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) resetForm();
    onOpenChange(isOpen);
  };

  // Key columns to show in preview (subset to fit dialog)
  const previewColumns = [
    "First Name",
    "Last Name",
    "Company",
    "Email",
    "Phone",
    "Lead Status",
    "Lead Source",
  ].filter((col) => previewHeaders.includes(col));

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === "upload" && "Import Leads from CSV"}
            {step === "preview" && "Preview Import"}
            {step === "result" && "Import Results"}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1: File Upload */}
        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a CSV file exported from Zoho CRM. All fields will be
              automatically mapped.
            </p>

            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleFileChange}
              />
              <FileSpreadsheet className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium">
                {file ? file.name : "Drop CSV file here or click to browse"}
              </p>
              {file && (
                <p className="text-xs text-muted-foreground mt-1">
                  {(file.size / 1024).toFixed(1)} KB
                </p>
              )}
              {!file && (
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum 10MB, UTF-8 encoded
                </p>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Preview */}
        {step === "preview" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{totalRows}</span>{" "}
                leads found in the CSV. Showing first 5 rows:
              </p>
            </div>

            <div className="border rounded-md overflow-x-auto max-h-60">
              <Table>
                <TableHeader>
                  <TableRow>
                    {previewColumns.map((col) => (
                      <TableHead key={col} className="text-xs whitespace-nowrap">
                        {col}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((row, i) => (
                    <TableRow key={i}>
                      {previewColumns.map((col) => (
                        <TableCell
                          key={col}
                          className="text-xs max-w-[150px] truncate"
                        >
                          {row[col] || "—"}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                What will happen:
              </p>
              <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                <li>Fields will be auto-mapped from Zoho CRM format</li>
                <li>Leads with matching email addresses will be skipped</li>
                <li>Empty first names will be filled from last names</li>
                <li>
                  Status, source, and workspace type will be mapped to TWV CRM
                  values
                </li>
              </ul>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setStep("upload");
                  setFile(null);
                }}
              >
                Back
              </Button>
              <Button onClick={handleImport} disabled={submitting}>
                {submitting && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {submitting
                  ? `Importing ${totalRows} leads...`
                  : `Import ${totalRows} Leads`}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Results */}
        {step === "result" && result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border p-3 text-center">
                <CheckCircle2 className="mx-auto h-5 w-5 text-green-500 mb-1" />
                <p className="text-lg font-bold">{result.imported}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <AlertTriangle className="mx-auto h-5 w-5 text-yellow-500 mb-1" />
                <p className="text-lg font-bold">{result.skipped}</p>
                <p className="text-xs text-muted-foreground">
                  Skipped (Duplicates)
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <XCircle className="mx-auto h-5 w-5 text-red-500 mb-1" />
                <p className="text-lg font-bold">{result.errors.length}</p>
                <p className="text-xs text-muted-foreground">Errors</p>
              </div>
            </div>

            {/* Errors list */}
            {result.errors.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-destructive">Errors:</p>
                <div className="max-h-40 overflow-y-auto rounded-md border p-2 space-y-1">
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-xs text-destructive">
                      {err.row > 0 ? `Row ${err.row}: ` : ""}
                      {err.message}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Warnings */}
            {result.warnings && result.warnings.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-yellow-600">Warnings:</p>
                <div className="max-h-32 overflow-y-auto rounded-md border p-2 space-y-1">
                  {result.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-yellow-600">
                      {w}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
