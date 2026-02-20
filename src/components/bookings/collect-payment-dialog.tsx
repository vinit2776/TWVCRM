"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Script from "next/script";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, Upload, CheckCircle, XCircle, Eye,
  Banknote, Smartphone, CreditCard, Globe, ImageIcon, Maximize2, X,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils";
import {
  BOOKING_PAYMENT_RECORD_STATUS_LABELS,
  BOOKING_PAYMENT_RECORD_STATUS_COLORS,
  BOOKING_PAYMENT_MODE_LABELS,
} from "@/lib/constants";
import type { BookingPayment } from "@/types";

interface CollectPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  totalAmount: number;
  onSuccess: () => void;
  razorpayEnabled?: boolean;
  razorpayKeyId?: string;
  upiId?: string;
  upiQrCodePath?: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Razorpay: any;
  }
}

export function CollectPaymentDialog({
  open,
  onOpenChange,
  bookingId,
  totalAmount,
  onSuccess,
  razorpayEnabled = false,
  razorpayKeyId = "",
  upiId = "",
  upiQrCodePath = "",
}: CollectPaymentDialogProps) {
  const [payments, setPayments] = useState<BookingPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paymentMode, setPaymentMode] = useState<string>("cash");
  const [amount, setAmount] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // QR code signed URL & lightbox
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [qrZoomed, setQrZoomed] = useState(false);

  // Verification dialog state
  const [verifyingPayment, setVerifyingPayment] = useState<BookingPayment | null>(null);
  const [verifyNotes, setVerifyNotes] = useState("");
  const [verifyingSaving, setVerifyingSaving] = useState(false);

  const fetchPayments = useCallback(async () => {
    if (!bookingId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/booking-payments?booking_id=${bookingId}`);
      if (res.ok) {
        const json = await res.json();
        setPayments(json.data || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [bookingId]);

  useEffect(() => {
    if (open) {
      fetchPayments();
    }
  }, [open, fetchPayments]);

  // Fetch signed URL for QR code image
  useEffect(() => {
    if (!open || !upiQrCodePath) {
      setQrCodeUrl(null);
      return;
    }
    const fetchQrUrl = async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.storage
          .from("crm-documents")
          .createSignedUrl(upiQrCodePath, 3600); // 1 hour validity
        if (data?.signedUrl) {
          setQrCodeUrl(data.signedUrl);
        }
      } catch {
        console.error("Failed to load QR code image");
      }
    };
    fetchQrUrl();
  }, [open, upiQrCodePath]);

  const verifiedTotal = payments
    .filter((p) => p.status === "verified")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const pendingTotal = payments
    .filter((p) => p.status === "pending")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const balanceDue = Math.max(0, totalAmount - verifiedTotal);

  // Default amount to balance due
  useEffect(() => {
    if (open && balanceDue > 0) {
      setAmount(balanceDue.toFixed(2));
    }
  }, [open, balanceDue]);

  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setScreenshotPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmitPayment = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    if (amt > balanceDue + 0.01) {
      toast.error(`Amount exceeds balance due (${formatCurrency(balanceDue)})`);
      return;
    }

    // Razorpay flow
    if (paymentMode === "razorpay") {
      await handleRazorpayPayment(amt);
      return;
    }

    setSaving(true);
    try {
      // Create payment record
      const res = await fetch("/api/booking-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId,
          amount: amt,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to record payment");
        setSaving(false);
        return;
      }

      const paymentId = json.data?.id;

      // Upload screenshot if UPI
      if (paymentMode === "upi" && screenshotFile && paymentId) {
        const formData = new FormData();
        formData.append("file", screenshotFile);
        await fetch(`/api/booking-payments/${paymentId}/screenshot`, {
          method: "POST",
          body: formData,
        });
      }

      const modeLabel = BOOKING_PAYMENT_MODE_LABELS[paymentMode] || paymentMode;
      if (paymentMode === "cash" || paymentMode === "card") {
        toast.success(`${modeLabel} payment of ${formatCurrency(amt)} recorded`);
      } else {
        toast.success(`${modeLabel} payment submitted — pending verification`);
      }

      // Reset form
      setPaymentReference("");
      setScreenshotFile(null);
      setScreenshotPreview(null);

      // Refresh
      await fetchPayments();

      // Check if now fully paid
      const newVerified = verifiedTotal + ((paymentMode === "cash" || paymentMode === "card") ? amt : 0);
      if (newVerified >= totalAmount) {
        onSuccess();
        onOpenChange(false);
      }
    } catch {
      toast.error("Failed to record payment");
    } finally {
      setSaving(false);
    }
  };

  const handleRazorpayPayment = async (amt: number) => {
    if (!window.Razorpay) {
      toast.error("Razorpay is loading, please try again");
      return;
    }

    setSaving(true);
    try {
      // Create order
      const orderRes = await fetch("/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId, amount: amt }),
      });

      const orderJson = await orderRes.json();
      if (!orderRes.ok) {
        toast.error(orderJson.error || "Failed to create order");
        setSaving(false);
        return;
      }

      const { order_id, payment_record_id, razorpay_key_id: keyId, amount: amountInPaise } = orderJson.data;

      // Open Razorpay checkout
      const options = {
        key: keyId,
        amount: amountInPaise,
        currency: "INR",
        name: "The WorkVilla",
        description: "Booking Payment",
        order_id,
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          // Verify payment
          const verifyRes = await fetch("/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...response,
              payment_record_id,
            }),
          });

          if (verifyRes.ok) {
            toast.success("Online payment successful");
            await fetchPayments();
            onSuccess();
            onOpenChange(false);
          } else {
            toast.error("Payment verification failed");
            await fetchPayments();
          }
        },
        modal: {
          ondismiss: () => {
            toast.info("Payment cancelled");
            fetchPayments();
          },
        },
        theme: { color: "#1a1a2e" },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch {
      toast.error("Failed to initiate payment");
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (paymentId: string, action: "verified" | "rejected") => {
    setVerifyingSaving(true);
    try {
      const res = await fetch(`/api/booking-payments/${paymentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: action,
          verification_notes: verifyNotes.trim() || undefined,
        }),
      });

      if (res.ok) {
        toast.success(action === "verified" ? "Payment verified" : "Payment rejected");
        setVerifyingPayment(null);
        setVerifyNotes("");
        await fetchPayments();
        // If verified and now fully paid, close
        if (action === "verified") {
          const payment = payments.find((p) => p.id === paymentId);
          if (payment) {
            const newVerified = verifiedTotal + Number(payment.amount);
            if (newVerified >= totalAmount) {
              onSuccess();
              onOpenChange(false);
            }
          }
        }
      } else {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "Failed to update payment");
      }
    } catch {
      toast.error("Failed to update payment");
    } finally {
      setVerifyingSaving(false);
    }
  };

  const upiPayLink = upiId && amount
    ? `upi://pay?pa=${encodeURIComponent(upiId)}&am=${amount}&cu=INR&tn=Booking+Payment`
    : "";

  return (
    <>
      {razorpayEnabled && (
        <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="lazyOnload" />
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Collect Payment</DialogTitle>
          </DialogHeader>

          {/* Summary Bar */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md bg-muted/50 p-2.5">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-lg font-bold">{formatCurrency(totalAmount)}</p>
            </div>
            <div className="rounded-md bg-green-50 p-2.5">
              <p className="text-xs text-green-600">Paid</p>
              <p className="text-lg font-bold text-green-700">{formatCurrency(verifiedTotal)}</p>
            </div>
            <div className={`rounded-md p-2.5 ${balanceDue > 0 ? "bg-amber-50" : "bg-green-50"}`}>
              <p className={`text-xs ${balanceDue > 0 ? "text-amber-600" : "text-green-600"}`}>
                {balanceDue > 0 ? "Balance Due" : "Fully Paid"}
              </p>
              <p className={`text-lg font-bold ${balanceDue > 0 ? "text-amber-700" : "text-green-700"}`}>
                {formatCurrency(balanceDue)}
              </p>
            </div>
          </div>

          {pendingTotal > 0 && (
            <p className="text-xs text-amber-600 text-center">
              + {formatCurrency(pendingTotal)} pending verification
            </p>
          )}

          {/* Payment History */}
          {payments.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Payment History</Label>
              <div className="border rounded-md divide-y max-h-40 overflow-y-auto">
                {payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{formatCurrency(p.amount)}</span>
                      <span className="text-xs text-muted-foreground">
                        {BOOKING_PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className={`text-[10px] ${BOOKING_PAYMENT_RECORD_STATUS_COLORS[p.status]}`}>
                        {BOOKING_PAYMENT_RECORD_STATUS_LABELS[p.status]}
                      </Badge>
                      {p.status === "pending" && p.payment_mode === "upi" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs px-2"
                          onClick={() => { setVerifyingPayment(p); setVerifyNotes(""); }}
                        >
                          <Eye className="mr-1 h-3 w-3" />Verify
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Add Payment Form */}
          {balanceDue > 0 && (
            <>
              <Separator />

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="1"
                    max={balanceDue}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={`Max ${formatCurrency(balanceDue)}`}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Payment Method</Label>
                  <Tabs value={paymentMode} onValueChange={setPaymentMode}>
                    <TabsList className="grid w-full grid-cols-4">
                      <TabsTrigger value="cash" className="text-xs gap-1">
                        <Banknote className="h-3.5 w-3.5" />Cash
                      </TabsTrigger>
                      <TabsTrigger value="upi" className="text-xs gap-1">
                        <Smartphone className="h-3.5 w-3.5" />UPI
                      </TabsTrigger>
                      <TabsTrigger value="card" className="text-xs gap-1">
                        <CreditCard className="h-3.5 w-3.5" />Card
                      </TabsTrigger>
                      {razorpayEnabled && (
                        <TabsTrigger value="razorpay" className="text-xs gap-1">
                          <Globe className="h-3.5 w-3.5" />Online
                        </TabsTrigger>
                      )}
                    </TabsList>

                    {/* Cash */}
                    <TabsContent value="cash" className="mt-3">
                      <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-800">
                        <Banknote className="inline-block h-4 w-4 mr-1.5" />
                        Cash payment of <strong>{formatCurrency(parseFloat(amount) || 0)}</strong> will be recorded as collected.
                      </div>
                    </TabsContent>

                    {/* UPI */}
                    <TabsContent value="upi" className="mt-3 space-y-4">
                      {/* QR Code — click to enlarge */}
                      {upiQrCodePath && (
                        <div className="flex flex-col items-center">
                          <div
                            className="relative border-2 border-muted rounded-xl p-3 bg-white shadow-sm cursor-pointer group hover:border-primary/40 transition-colors"
                            onClick={() => qrCodeUrl && setQrZoomed(true)}
                          >
                            {qrCodeUrl ? (
                              <>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={qrCodeUrl}
                                  alt="UPI QR Code"
                                  className="w-48 h-48 object-contain"
                                />
                                <div className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
                                  <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 text-white text-xs px-2.5 py-1 rounded-full flex items-center gap-1">
                                    <Maximize2 className="h-3 w-3" />
                                    Tap to enlarge
                                  </div>
                                </div>
                              </>
                            ) : (
                              <div className="w-48 h-48 flex items-center justify-center">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                              </div>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-2">Scan to pay {formatCurrency(parseFloat(amount) || 0)}</p>
                        </div>
                      )}

                      {/* UPI ID + Pay link */}
                      {upiId && (
                        <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">UPI ID</p>
                            <code className="text-sm font-mono block truncate">{upiId}</code>
                          </div>
                          {upiPayLink && (
                            <a
                              href={upiPayLink}
                              className="shrink-0 ml-3 text-xs font-medium text-primary hover:underline"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Open UPI App →
                            </a>
                          )}
                        </div>
                      )}

                      {/* Payment reference */}
                      <div className="space-y-1.5">
                        <Label className="text-xs">UPI Transaction Reference</Label>
                        <Input
                          value={paymentReference}
                          onChange={(e) => setPaymentReference(e.target.value)}
                          placeholder="UPI Ref / UTR Number"
                        />
                      </div>

                      {/* Screenshot upload */}
                      <div className="space-y-1.5">
                        <Label className="text-xs">Payment Screenshot</Label>
                        {screenshotPreview ? (
                          <div className="relative border rounded-md p-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={screenshotPreview}
                              alt="Payment screenshot"
                              className="max-h-40 mx-auto rounded"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="absolute top-1 right-1 h-7 text-xs"
                              onClick={() => {
                                setScreenshotFile(null);
                                setScreenshotPreview(null);
                              }}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-1" />Remove
                            </Button>
                          </div>
                        ) : (
                          <div
                            className="border-2 border-dashed rounded-lg p-3 text-center cursor-pointer hover:border-primary/50 transition-colors"
                            onClick={() => fileInputRef.current?.click()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const file = e.dataTransfer.files[0];
                              if (file) handleFileSelect(file);
                            }}
                            onDragOver={(e) => e.preventDefault()}
                          >
                            <Upload className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
                            <p className="text-xs text-muted-foreground">Click or drag payment screenshot</p>
                          </div>
                        )}
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFileSelect(file);
                            e.target.value = "";
                          }}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          Upload screenshot for verification. Payment will be pending until verified by a manager.
                        </p>
                      </div>
                    </TabsContent>

                    {/* Card */}
                    <TabsContent value="card" className="mt-3 space-y-3">
                      <div className="space-y-2">
                        <Label>Transaction Reference</Label>
                        <Input
                          value={paymentReference}
                          onChange={(e) => setPaymentReference(e.target.value)}
                          placeholder="Card terminal transaction ID"
                        />
                      </div>
                    </TabsContent>

                    {/* Razorpay */}
                    {razorpayEnabled && (
                      <TabsContent value="razorpay" className="mt-3">
                        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
                          <Globe className="inline-block h-4 w-4 mr-1.5" />
                          Online payment of <strong>{formatCurrency(parseFloat(amount) || 0)}</strong> via Razorpay.
                          A checkout window will open.
                        </div>
                      </TabsContent>
                    )}
                  </Tabs>
                </div>

                <Button
                  className="w-full"
                  onClick={handleSubmitPayment}
                  disabled={saving || !amount || parseFloat(amount) <= 0}
                >
                  {saving ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing...</>
                  ) : paymentMode === "razorpay" ? (
                    `Pay ${formatCurrency(parseFloat(amount) || 0)} Online`
                  ) : paymentMode === "cash" ? (
                    `Record Cash Payment — ${formatCurrency(parseFloat(amount) || 0)}`
                  ) : paymentMode === "upi" ? (
                    `Submit UPI Payment — ${formatCurrency(parseFloat(amount) || 0)}`
                  ) : (
                    `Record Card Payment — ${formatCurrency(parseFloat(amount) || 0)}`
                  )}
                </Button>
              </div>
            </>
          )}

          {balanceDue <= 0 && !loading && (
            <div className="text-center py-4">
              <CheckCircle className="h-8 w-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-green-700">Payment Complete</p>
              <p className="text-xs text-muted-foreground mt-1">All payments have been collected and verified.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => { onSuccess(); onOpenChange(false); }}
              >
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* QR Code Lightbox */}
      {qrZoomed && qrCodeUrl && (
        <div
          className="fixed inset-0 z-[200] bg-black/80 flex flex-col items-center justify-center p-6 cursor-pointer"
          onClick={() => setQrZoomed(false)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
            onClick={() => setQrZoomed(false)}
          >
            <X className="h-8 w-8" />
          </button>
          <div className="bg-white rounded-2xl p-5 shadow-2xl max-w-[90vw] max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrCodeUrl}
              alt="UPI QR Code"
              className="w-[75vmin] h-[75vmin] max-w-[400px] max-h-[400px] object-contain"
            />
          </div>
          <p className="text-white/70 text-sm mt-4">Scan to pay {formatCurrency(parseFloat(amount) || 0)}</p>
          <p className="text-white/40 text-xs mt-1">Tap anywhere to close</p>
        </div>
      )}

      {/* Verification Sub-Dialog */}
      {verifyingPayment && (
        <Dialog open={!!verifyingPayment} onOpenChange={() => setVerifyingPayment(null)}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>Verify UPI Payment</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-md bg-muted/50 p-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-bold">{formatCurrency(verifyingPayment.amount)}</span>
                </div>
                {verifyingPayment.payment_reference && (
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-muted-foreground">Reference</span>
                    <span className="font-mono text-xs">{verifyingPayment.payment_reference}</span>
                  </div>
                )}
              </div>

              {verifyingPayment.screenshot_path ? (
                <div className="text-center text-sm text-muted-foreground">
                  <p className="mb-2">Payment screenshot uploaded</p>
                  <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                    <ImageIcon className="mr-1 h-3 w-3" />Screenshot available
                  </Badge>
                </div>
              ) : (
                <div className="text-center text-sm text-amber-600">
                  No screenshot uploaded for this payment
                </div>
              )}

              <div className="space-y-2">
                <Label>Verification Notes</Label>
                <Input
                  value={verifyNotes}
                  onChange={(e) => setVerifyNotes(e.target.value)}
                  placeholder="Optional — reason for rejection, amount mismatch details..."
                />
              </div>

              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={() => handleVerify(verifyingPayment.id, "rejected")}
                  disabled={verifyingSaving}
                >
                  <XCircle className="mr-1 h-4 w-4" />Reject
                </Button>
                <Button
                  className="flex-1 bg-green-600 hover:bg-green-700"
                  onClick={() => handleVerify(verifyingPayment.id, "verified")}
                  disabled={verifyingSaving}
                >
                  {verifyingSaving ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="mr-1 h-4 w-4" />
                  )}
                  Verify
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
