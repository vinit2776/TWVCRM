"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  CreditCard, Eye, EyeOff, Loader2, CheckCircle, XCircle,
  Upload, Image as ImageIcon, Link2, Trash2,
} from "lucide-react";
import { toast } from "sonner";

export function PaymentGatewaySettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [uploadingQr, setUploadingQr] = useState(false);
  const qrInputRef = useRef<HTMLInputElement>(null);

  const [settings, setSettings] = useState({
    razorpay_enabled: "false",
    razorpay_key_id: "",
    razorpay_key_secret: "",
    razorpay_webhook_secret: "",
    upi_id: "",
    upi_qr_code_path: "",
  });

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const json = await res.json();
          const data = json.data as { key: string; value: string }[];
          const map: Record<string, string> = {};
          data.forEach((s) => { map[s.key] = s.value; });
          setSettings((prev) => ({ ...prev, ...map }));
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings)) {
        if (key !== "upi_qr_code_path") {
          payload[key] = value;
        }
      }

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success("Payment gateway settings saved");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save first before testing
      await handleSave();

      const res = await fetch("/api/settings/test-razorpay", { method: "POST" });
      const json = await res.json();
      setTestResult({ success: json.success || res.ok, message: json.message });
    } catch {
      setTestResult({ success: false, message: "Connection test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleQrUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("File size must be under 5MB");
      return;
    }

    setUploadingQr(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", "settings/upi-qr");

      const res = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const json = await res.json();
        const filePath = json.data?.file_path || "";
        // Update the setting with the new path
        setSettings((prev) => ({ ...prev, upi_qr_code_path: filePath }));
        // Save the path to settings
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upi_qr_code_path: filePath }),
        });
        toast.success("UPI QR code uploaded");
      } else {
        toast.error("Failed to upload QR code");
      }
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploadingQr(false);
    }
  };

  const appUrl = typeof window !== "undefined" ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL || "";

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Razorpay Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Razorpay Payment Gateway
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable/Disable */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Enable Razorpay</Label>
              <p className="text-xs text-muted-foreground">Allow online payments via Razorpay checkout</p>
            </div>
            <Switch
              checked={settings.razorpay_enabled === "true"}
              onCheckedChange={(checked) =>
                setSettings((prev) => ({ ...prev, razorpay_enabled: checked ? "true" : "false" }))
              }
            />
          </div>

          <Separator />

          {/* API Keys */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key_id">Key ID</Label>
              <Input
                id="key_id"
                value={settings.razorpay_key_id}
                onChange={(e) => setSettings((prev) => ({ ...prev, razorpay_key_id: e.target.value }))}
                placeholder="rzp_live_XXXXXXXXXXXX"
              />
              <p className="text-xs text-muted-foreground">Your Razorpay API Key ID (starts with rzp_live_ or rzp_test_)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="key_secret">Key Secret</Label>
              <div className="relative">
                <Input
                  id="key_secret"
                  type={showSecret ? "text" : "password"}
                  value={settings.razorpay_key_secret}
                  onChange={(e) => setSettings((prev) => ({ ...prev, razorpay_key_secret: e.target.value }))}
                  placeholder="Enter Key Secret"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhook_secret">Webhook Secret</Label>
              <div className="relative">
                <Input
                  id="webhook_secret"
                  type={showWebhookSecret ? "text" : "password"}
                  value={settings.razorpay_webhook_secret}
                  onChange={(e) => setSettings((prev) => ({ ...prev, razorpay_webhook_secret: e.target.value }))}
                  placeholder="Enter Webhook Secret"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                  onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                >
                  {showWebhookSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Webhook URL</Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <code className="text-xs break-all">{appUrl}/api/payments/webhook</code>
              </div>
              <p className="text-xs text-muted-foreground">
                Configure this URL in your Razorpay Dashboard → Webhooks → Add New Webhook
              </p>
            </div>
          </div>

          <Separator />

          {/* Test Connection + Save */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={testing || !settings.razorpay_key_id}
              >
                {testing ? (
                  <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Testing...</>
                ) : (
                  "Test Connection"
                )}
              </Button>
              {testResult && (
                <div className="flex items-center gap-1.5 text-sm">
                  {testResult.success ? (
                    <><CheckCircle className="h-4 w-4 text-green-600" /><span className="text-green-700">{testResult.message}</span></>
                  ) : (
                    <><XCircle className="h-4 w-4 text-red-600" /><span className="text-red-700">{testResult.message}</span></>
                  )}
                </div>
              )}
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Razorpay Settings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* UPI Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            UPI Payment Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="upi_id">UPI ID</Label>
            <Input
              id="upi_id"
              value={settings.upi_id}
              onChange={(e) => setSettings((prev) => ({ ...prev, upi_id: e.target.value }))}
              placeholder="merchant@upi"
            />
            <p className="text-xs text-muted-foreground">Used to generate dynamic QR codes with pre-filled amount</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Static QR Code Image</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Upload a QR code image that will be displayed when collecting UPI payments
            </p>
            {settings.upi_qr_code_path ? (
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="bg-green-100 text-green-800">
                  <CheckCircle className="mr-1 h-3 w-3" />QR uploaded
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 h-7"
                  onClick={() => {
                    setSettings((prev) => ({ ...prev, upi_qr_code_path: "" }));
                    fetch("/api/settings", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ upi_qr_code_path: "" }),
                    });
                  }}
                >
                  <Trash2 className="mr-1 h-3 w-3" />Remove
                </Button>
              </div>
            ) : (
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => qrInputRef.current?.click()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (file) handleQrUpload(file);
                }}
                onDragOver={(e) => e.preventDefault()}
              >
                <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {uploadingQr ? "Uploading..." : "Click or drag & drop QR code image"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">PNG, JPG up to 5MB</p>
              </div>
            )}
            <input
              ref={qrInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleQrUpload(file);
                e.target.value = "";
              }}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
