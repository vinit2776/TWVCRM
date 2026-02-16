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
import { Loader2, Upload, FileText, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { VOUCHER_VALIDITY_OPTIONS, VOUCHER_VALIDITY_LABELS } from "@/lib/constants";

interface UploadVouchersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  preselectedValidity?: number;
}

interface ParseResult {
  count: number;
  detected_validity: number | null;
  applied_validity: number | null;
  parse_warnings: string[];
}

export function UploadVouchersDialog({
  open,
  onOpenChange,
  onSuccess,
  preselectedValidity,
}: UploadVouchersDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [validityOverride, setValidityOverride] = useState<string>(
    preselectedValidity ? String(preselectedValidity) : "auto"
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setFile(null);
    setValidityOverride(preselectedValidity ? String(preselectedValidity) : "auto");
    setResult(null);
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0] || null;
    setFile(selectedFile);
    setResult(null);
    setError("");
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && droppedFile.name.toLowerCase().endsWith(".pdf")) {
      setFile(droppedFile);
      setResult(null);
      setError("");
    } else {
      setError("Only PDF files are accepted.");
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleSubmit = async () => {
    if (!file) return;

    setSubmitting(true);
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    if (validityOverride !== "auto") {
      formData.append("validity_days", validityOverride);
    }

    const res = await fetch("/api/vouchers", {
      method: "POST",
      body: formData,
    });

    setSubmitting(false);

    if (res.ok) {
      const json = await res.json();
      setResult({
        count: json.count || 0,
        detected_validity: json.detected_validity,
        applied_validity: json.applied_validity,
        parse_warnings: json.parse_warnings || [],
      });
      toast.success(
        `Successfully uploaded ${json.count} voucher${json.count !== 1 ? "s" : ""} from PDF`
      );
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      setError(err?.error || "Failed to upload vouchers");
      if (err?.parse_warnings?.length) {
        setError(
          `${err.error}\n\nWarnings:\n${err.parse_warnings.join("\n")}`
        );
      }
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) resetForm();
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Vouchers (PDF)</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Drop Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => fileInputRef.current?.click()}
            className="relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              className="hidden"
            />
            {file ? (
              <div className="space-y-2">
                <FileText className="h-10 w-10 mx-auto text-primary" />
                <p className="text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} KB
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                    setResult(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Drop a voucher PDF here or click to browse
                </p>
                <p className="text-xs text-muted-foreground">
                  Supports PDF files with voucher codes in XXXXX-XXXXX format
                </p>
              </div>
            )}
          </div>

          {/* Validity Override */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Validity Period</label>
            <Select value={validityOverride} onValueChange={setValidityOverride}>
              <SelectTrigger>
                <SelectValue placeholder="Auto-detect from PDF" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect from PDF</SelectItem>
                {VOUCHER_VALIDITY_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {VOUCHER_VALIDITY_LABELS[days]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The system will auto-detect validity from the PDF header. Override if needed.
            </p>
          </div>

          {/* Error Display */}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 whitespace-pre-wrap">
              <AlertTriangle className="inline h-4 w-4 mr-1 -mt-0.5" />
              {error}
            </div>
          )}

          {/* Success Result */}
          {result && (
            <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-2">
              <div className="flex items-center gap-2 text-green-800">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">
                  {result.count} voucher{result.count !== 1 ? "s" : ""} uploaded
                </span>
              </div>
              <div className="text-sm text-green-700 space-y-1">
                {result.detected_validity && (
                  <p>
                    Detected validity:{" "}
                    <Badge variant="secondary" className="ml-1">
                      {result.detected_validity}d
                    </Badge>
                  </p>
                )}
                {result.applied_validity && (
                  <p>
                    Applied validity:{" "}
                    <Badge variant="secondary" className="ml-1">
                      {result.applied_validity}d
                    </Badge>
                  </p>
                )}
              </div>
              {result.parse_warnings.length > 0 && (
                <div className="text-xs text-amber-700 mt-2">
                  <AlertTriangle className="inline h-3 w-3 mr-1" />
                  {result.parse_warnings.join("; ")}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button onClick={handleSubmit} disabled={!file || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload PDF
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
