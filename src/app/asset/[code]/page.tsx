"use client";

import { use, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, AlertTriangle, Loader2, MapPin, Tag,
  Upload, FileText, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AssetInfo {
  id: string;
  name: string;
  asset_code: string;
  status: string;
  location_name: string | null;
  floor_name: string | null;
  category_name: string | null;
  has_active_amc: boolean;
}

export default function PublicAssetPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [asset, setAsset] = useState<AssetInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [isAuth, setIsAuth] = useState<boolean | null>(null);

  // Check auth and redirect staff to the dashboard asset page
  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.role) { setIsAuth(false); return; }
        // Confirmed staff — fetch asset id then redirect
        setIsAuth(true);
        fetch(`/api/public/asset/${code}`)
          .then((r) => r.json())
          .then((j) => {
            if (j.data?.id) {
              router.replace(`/facility/assets/${j.data.id}`);
            } else {
              setIsAuth(false); // asset not found — show public page
            }
          })
          .catch(() => setIsAuth(false));
      })
      .catch(() => setIsAuth(false));
  }, [code, router]);

  // Fetch public asset info
  useEffect(() => {
    fetch(`/api/public/asset/${code}`)
      .then((r) => {
        if (!r.ok) { setNotFound(true); setLoading(false); return null; }
        return r.json();
      })
      .then((j) => {
        if (j?.data) setAsset(j.data);
        setLoading(false);
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [code]);

  if (isAuth === true) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-2">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-gray-400" />
          <p className="text-sm text-gray-500">Redirecting to asset details…</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (notFound || !asset) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center space-y-2">
          <AlertTriangle className="h-8 w-8 mx-auto text-amber-500" />
          <h1 className="text-lg font-semibold">Asset Not Found</h1>
          <p className="text-sm text-gray-500">
            The QR code may be outdated or the asset has been removed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-4">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
            <span className="font-mono">{asset.asset_code}</span>
            <span className={cn(
              "px-1.5 py-0.5 rounded-full text-[10px] font-medium",
              asset.status === "active" ? "bg-emerald-100 text-emerald-700" :
              asset.status === "maintenance" ? "bg-amber-100 text-amber-700" :
              "bg-gray-100 text-gray-600"
            )}>
              {asset.status}
            </span>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">{asset.name}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
            {asset.location_name && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {asset.location_name}
                {asset.floor_name && ` · ${asset.floor_name}`}
              </span>
            )}
            {asset.category_name && (
              <span className="flex items-center gap-1">
                <Tag className="h-3.5 w-3.5" />
                {asset.category_name}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Service sheet upload — only when asset has active AMC */}
        {asset.has_active_amc && (
          <ServiceUploadForm assetCode={code} assetName={asset.name} />
        )}

        {/* Report issue form — always available */}
        <ReportForm assetCode={code} assetName={asset.name} />
      </div>

      <div className="text-center text-xs text-gray-400 py-6">
        The WorkVilla · Facility Management
      </div>
    </div>
  );
}

/* ── Service sheet upload (AMC only) ───────────────────────────── */

function ServiceUploadForm({ assetCode, assetName }: { assetCode: string; assetName: string }) {
  const [vendorName, setVendorName] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    const valid = selected.filter((f) => allowed.includes(f.type));
    if (valid.length !== selected.length) {
      toast.error("Only PDF, JPEG, PNG, and WebP files are allowed");
    }
    setFiles((prev) => [...prev, ...valid].slice(0, 5));
    e.target.value = "";
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!vendorName.trim() || files.length === 0) return;

    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("vendor_name", vendorName.trim());
      if (notes.trim()) fd.append("vendor_notes", notes.trim());
      for (const f of files) fd.append("files", f);

      const res = await fetch(`/api/public/asset/${assetCode}/service/upload`, {
        method: "POST",
        body: fd,
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");

      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="rounded-xl bg-white border p-6 text-center space-y-3">
        <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
        <h2 className="text-lg font-semibold">Service Sheet Uploaded</h2>
        <p className="text-sm text-gray-500">
          Thank you, <span className="font-medium">{vendorName}</span>. The facility team will review it.
        </p>
        <Button variant="outline" size="sm" onClick={() => {
          setSubmitted(false);
          setFiles([]);
          setNotes("");
        }}>
          Upload another
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl bg-white border p-4 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900">Upload Service / Repair Sheet</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Completed AMC service on <span className="font-medium">{assetName}</span>? Upload your report here.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">Technician / Vendor Name *</label>
        <input
          value={vendorName}
          onChange={(e) => setVendorName(e.target.value)}
          placeholder="e.g. Raj Kumar, ABC Services"
          required
          maxLength={100}
          className="w-full h-10 px-3 rounded-lg border text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-colors"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">Service Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was done? Parts replaced? Observations?"
          rows={3}
          maxLength={2000}
          className="w-full px-3 py-2 rounded-lg border text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-colors resize-none"
        />
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1.5">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2">
              <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-xs text-gray-400">{(f.size / 1024).toFixed(0)} KB</span>
              <button type="button" onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* File picker */}
      {files.length < 5 && (
        <label className="flex items-center justify-center gap-2 h-20 border-2 border-dashed rounded-lg cursor-pointer text-sm text-gray-400 hover:bg-gray-50 hover:border-gray-400 transition-colors">
          <Upload className="h-4 w-4" />
          Tap to select photos or PDF
          <input
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={handleFileSelect}
            className="hidden"
          />
        </label>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={submitting || !vendorName.trim() || files.length === 0}
      >
        {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
        {submitting ? "Uploading…" : "Upload Service Sheet"}
      </Button>
    </form>
  );
}

/* ── Report issue form (always available) ──────────────────────── */

function ReportForm({ assetCode, assetName }: { assetCode: string; assetName: string }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterPhone, setReporterPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !reporterName.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/asset/${assetCode}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          reporter_name: reporterName.trim(),
          reporter_phone: reporterPhone.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Submission failed");

      setSubmitted(json.data.issue_number);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit report");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="rounded-xl bg-white border p-6 text-center space-y-3">
        <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
        <h2 className="text-lg font-semibold">Issue Reported</h2>
        <p className="text-sm text-gray-500">
          Your issue has been logged as <span className="font-mono font-semibold">{submitted}</span> and
          the facility team has been notified.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSubmitted(null);
            setTitle("");
            setDescription("");
          }}
        >
          Report another issue
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl bg-white border p-4 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900">Report an Issue</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Something wrong with <span className="font-medium">{assetName}</span>? Let us know.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">What&apos;s the problem? *</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. AC not cooling, strange noise"
          required
          maxLength={200}
          className="w-full h-10 px-3 rounded-lg border text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-colors"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">Details (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When did it start? Any specific observations?"
          rows={3}
          maxLength={2000}
          className="w-full px-3 py-2 rounded-lg border text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-colors resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700">Your name *</label>
          <input
            value={reporterName}
            onChange={(e) => setReporterName(e.target.value)}
            placeholder="Name"
            required
            maxLength={100}
            className="w-full h-10 px-3 rounded-lg border text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-colors"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700">Phone</label>
          <input
            value={reporterPhone}
            onChange={(e) => setReporterPhone(e.target.value)}
            placeholder="Optional"
            maxLength={20}
            className="w-full h-10 px-3 rounded-lg border text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-colors"
          />
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={submitting || !title.trim() || !reporterName.trim()}>
        {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
        Submit Report
      </Button>
    </form>
  );
}
