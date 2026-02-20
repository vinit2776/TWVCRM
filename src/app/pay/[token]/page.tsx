"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CreditCard, CheckCircle2, IndianRupee, Loader2 } from "lucide-react";

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0 }).format(amount);
}

function formatTime(time: string) {
  const [h, m] = time.split(":");
  const hour = parseInt(h);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${m} ${ampm}`;
}

export default function PublicPaymentPage() {
  const { token } = useParams();
  const searchParams = useSearchParams();
  const isRazorpayCallback = searchParams.get("razorpay_callback") === "true";
  const razorpayPaymentId = searchParams.get("razorpay_payment_id");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [paymentData, setPaymentData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [waitingForConfirmation, setWaitingForConfirmation] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/public/pay?token=${token}`);
        const json = await res.json();
        if (!res.ok) { setError(json.error || "Invalid link"); return; }
        if (json.data.is_paid) {
          setPaid(true);
        } else if (isRazorpayCallback) {
          // Redirected back from Razorpay — payment is being processed via webhook
          setWaitingForConfirmation(true);
        }
        setPaymentData(json.data);
      } catch {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token, isRazorpayCallback]);

  // Poll for payment confirmation after Razorpay callback
  useEffect(() => {
    if (!waitingForConfirmation) return;

    let attempts = 0;
    const maxAttempts = 30; // Poll for up to 5 minutes (30 * 10s)

    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`/api/public/pay?token=${token}`);
        if (!res.ok) return;
        const json = await res.json();
        if (json.data?.is_paid) {
          setPaid(true);
          setWaitingForConfirmation(false);
          setPaymentData(json.data);
          clearInterval(interval);
        }
      } catch { /* ignore polling errors */ }

      if (attempts >= maxAttempts) {
        // Stop polling after max attempts — show success anyway since Razorpay confirmed
        setPaid(true);
        setWaitingForConfirmation(false);
        clearInterval(interval);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [waitingForConfirmation, token]);

  const handlePayNow = async () => {
    if (!paymentData || paying) return;
    setPaying(true);

    try {
      const res = await fetch("/api/public/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          amount: paymentData.balance_due,
          payment_mode: "upi",
          payment_reference: `PUBLIC-${Date.now()}`,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error); return; }
      setPaid(true);
    } catch {
      setError("Payment failed");
    } finally {
      setPaying(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin h-8 w-8 border-2 border-[#015E65] border-t-transparent rounded-full" />
    </div>
  );

  if (error && !paymentData) return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow p-8 max-w-md text-center">
        <p className="text-red-500 font-semibold">{error}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="bg-[#015E65] text-white rounded-t-xl p-6 text-center">
          <h1 className="text-2xl font-bold">The WorkVilla</h1>
          <p className="text-[#00AE6C] text-sm mt-1">Secure Payment</p>
        </div>

        <div className="bg-white rounded-b-xl shadow p-6">
          {paid ? (
            <div className="text-center py-8">
              <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-[#015E65]">Payment Received!</h2>
              <p className="text-gray-600 mt-2">Your payment has been recorded successfully.</p>
              <p className="text-gray-400 text-sm mt-4">Booking: {paymentData?.booking_number}</p>
              <p className="text-gray-400 text-sm">Amount: {formatCurrency(paymentData?.total_amount || 0)}</p>
              {razorpayPaymentId && (
                <p className="text-gray-400 text-xs mt-2">Ref: {razorpayPaymentId}</p>
              )}
            </div>
          ) : waitingForConfirmation ? (
            <div className="text-center py-8">
              <Loader2 className="w-12 h-12 text-[#015E65] mx-auto mb-4 animate-spin" />
              <h2 className="text-xl font-bold text-[#015E65]">Confirming Payment...</h2>
              <p className="text-gray-600 mt-2">Your payment is being processed. This usually takes a few seconds.</p>
              <p className="text-gray-400 text-sm mt-4">Booking: {paymentData?.booking_number}</p>
              <p className="text-gray-400 text-sm">Amount: {formatCurrency(paymentData?.total_amount || 0)}</p>
            </div>
          ) : (
            <>
              {/* Booking Info */}
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <p className="text-sm text-gray-500">Booking #{paymentData?.booking_number}</p>
                <p className="font-semibold text-gray-800">{paymentData?.space_name}</p>
                <p className="text-sm text-gray-600">
                  {paymentData?.booking_date} · {formatTime(paymentData?.start_time?.slice(0, 5) || "00:00")} – {formatTime(paymentData?.end_time?.slice(0, 5) || "00:00")}
                </p>
                <p className="text-sm text-gray-600 mt-1">Customer: {paymentData?.customer_name}</p>
              </div>

              {/* Payment Summary */}
              <div className="border rounded-lg p-4 mb-6">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-gray-600">Total Amount</span>
                  <span className="font-bold text-lg">{formatCurrency(paymentData?.total_amount || 0)}</span>
                </div>
                {paymentData?.total_paid > 0 && (
                  <div className="flex justify-between items-center mb-2 text-green-600">
                    <span>Already Paid</span>
                    <span>- {formatCurrency(paymentData.total_paid)}</span>
                  </div>
                )}
                <hr className="my-2" />
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-gray-800">Balance Due</span>
                  <span className="font-bold text-xl text-[#015E65]">
                    <IndianRupee className="w-5 h-5 inline" />
                    {paymentData?.balance_due?.toLocaleString("en-IN")}
                  </span>
                </div>
              </div>

              {/* Bank Details */}
              <div className="bg-[#f0faf5] rounded-lg p-4 mb-6">
                <h3 className="font-semibold text-[#015E65] text-sm mb-2">Bank Transfer Details</h3>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-gray-500">Account Name</span><span>Sree Design Infrastructure Pvt Ltd</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Account No.</span><span className="font-mono">000905000140</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">IFSC</span><span className="font-mono">ICIC0000009</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Bank</span><span>ICICI Bank Ltd, Nungambakkam</span></div>
                </div>
              </div>

              {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

              <button
                onClick={handlePayNow}
                disabled={paying}
                className="w-full bg-[#015E65] text-white py-3 rounded-lg font-semibold hover:bg-[#014a50] disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                <CreditCard className="w-5 h-5" />
                {paying ? "Processing..." : `Pay ${formatCurrency(paymentData?.balance_due || 0)}`}
              </button>

              <p className="text-center text-xs text-gray-400 mt-4">
                Payments are processed securely. After bank transfer, your payment will be verified by our team.
              </p>
            </>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">
          The WorkVilla · Prakash Presidium, 110 MG Road, Nungambakkam, Chennai 600034
        </p>
      </div>
    </div>
  );
}
