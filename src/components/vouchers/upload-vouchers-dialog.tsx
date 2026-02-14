"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Eye, Upload } from "lucide-react";
import { toast } from "sonner";

interface ParsedVoucher {
  voucher_code: string;
  metadata: Record<string, unknown>;
}

interface UploadVouchersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const PLACEHOLDER_JSON = `[
  {
    "voucher_code": "TWV-WIFI-001",
    "metadata": { "type": "wifi", "plan": "50mbps" }
  },
  {
    "voucher_code": "TWV-WIFI-002",
    "metadata": { "type": "wifi", "plan": "100mbps" }
  }
]`;

export function UploadVouchersDialog({
  open,
  onOpenChange,
  onSuccess,
}: UploadVouchersDialogProps) {
  const [jsonInput, setJsonInput] = useState("");
  const [parsed, setParsed] = useState<ParsedVoucher[] | null>(null);
  const [parseError, setParseError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setJsonInput("");
    setParsed(null);
    setParseError("");
  };

  const handleParse = () => {
    setParseError("");
    setParsed(null);

    if (!jsonInput.trim()) {
      setParseError("Please enter JSON data.");
      return;
    }

    try {
      const data = JSON.parse(jsonInput.trim());

      if (!Array.isArray(data)) {
        setParseError("Input must be a JSON array.");
        return;
      }

      if (data.length === 0) {
        setParseError("Array must contain at least one voucher.");
        return;
      }

      const vouchers: ParsedVoucher[] = [];
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (!item.voucher_code || typeof item.voucher_code !== "string") {
          setParseError(`Item at index ${i} is missing a valid "voucher_code" string.`);
          return;
        }
        vouchers.push({
          voucher_code: item.voucher_code.trim(),
          metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
        });
      }

      // Check for duplicate voucher codes within the batch
      const codes = vouchers.map((v) => v.voucher_code);
      const duplicates = codes.filter((code, idx) => codes.indexOf(code) !== idx);
      if (duplicates.length > 0) {
        setParseError(`Duplicate voucher codes found: ${[...new Set(duplicates)].join(", ")}`);
        return;
      }

      setParsed(vouchers);
    } catch {
      setParseError("Invalid JSON. Please check your input format.");
    }
  };

  const handleSubmit = async () => {
    if (!parsed || parsed.length === 0) return;

    setSubmitting(true);
    const res = await fetch("/api/vouchers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vouchers: parsed }),
    });

    setSubmitting(false);

    if (res.ok) {
      const json = await res.json();
      const count = json.count || parsed.length;
      toast.success(`Successfully uploaded ${count} voucher${count !== 1 ? "s" : ""}`);
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to upload vouchers");
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      resetForm();
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Vouchers</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* JSON Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Voucher JSON <span className="text-destructive">*</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Paste a JSON array of voucher objects. Each object must have a{" "}
              <code className="bg-muted px-1 rounded">voucher_code</code> and optional{" "}
              <code className="bg-muted px-1 rounded">metadata</code>.
            </p>
            <Textarea
              value={jsonInput}
              onChange={(e) => {
                setJsonInput(e.target.value);
                setParsed(null);
                setParseError("");
              }}
              placeholder={PLACEHOLDER_JSON}
              rows={10}
              className="font-mono text-xs"
            />
          </div>

          {/* Parse Error */}
          {parseError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {parseError}
            </div>
          )}

          {/* Parse Button */}
          {!parsed && (
            <Button type="button" variant="outline" onClick={handleParse} disabled={!jsonInput.trim()}>
              <Eye className="mr-2 h-4 w-4" />
              Parse &amp; Preview
            </Button>
          )}

          {/* Preview Table */}
          {parsed && parsed.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Preview: <Badge variant="secondary">{parsed.length}</Badge> voucher{parsed.length !== 1 ? "s" : ""}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setParsed(null); setParseError(""); }}
                >
                  Edit JSON
                </Button>
              </div>
              <div className="rounded-md border overflow-x-auto max-h-[300px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-2 text-left font-medium w-12">#</th>
                      <th className="px-4 py-2 text-left font-medium">Voucher Code</th>
                      <th className="px-4 py-2 text-left font-medium">Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((v, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-4 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-4 py-2 font-mono text-xs">{v.voucher_code}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                          {Object.keys(v.metadata).length > 0
                            ? JSON.stringify(v.metadata)
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!parsed || parsed.length === 0 || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Upload {parsed ? `${parsed.length} Voucher${parsed.length !== 1 ? "s" : ""}` : "Vouchers"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
