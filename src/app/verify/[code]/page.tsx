"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { ShieldCheck, ShieldAlert, Loader2, AlertTriangle } from "lucide-react";

interface VerifyResult {
  found: boolean;
  is_valid: boolean;
  type?: string;
  reference?: string;
  department?: string;
  status?: string;
  approved_on?: string;
  approved_by?: string;
  company?: string;
  brand?: string;
  message?: string;
}

export default function PublicVerifyPage() {
  const { code } = useParams<{ code: string }>();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!code) return;
    fetch(`/api/public/verify?code=${encodeURIComponent(code)}`)
      .then(async (res) => {
        setResult(await res.json());
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [code]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#015E65] via-[#01757e] to-[#018a95]">
      {/* Header */}
      <header className="px-6 py-8 text-center">
        <h1 className="text-3xl font-bold text-white tracking-tight">The WorkVilla</h1>
        <p className="text-[#00AE6C] text-sm mt-1 font-medium">Document Verification Portal</p>
      </header>

      {/* Main Card */}
      <main className="max-w-lg mx-auto px-4 pb-12">
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          {/* Code Display */}
          <div className="bg-gray-50 border-b px-6 py-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Approval Code</p>
            <p className="text-xl font-mono font-bold text-[#015E65] tracking-widest mt-1">
              {decodeURIComponent(code || "")}
            </p>
          </div>

          <div className="px-6 py-6">
            {/* Loading */}
            {loading && (
              <div className="flex flex-col items-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-[#015E65]" />
                <p className="text-sm text-gray-500 mt-3">Verifying approval...</p>
              </div>
            )}

            {/* Error */}
            {error && !loading && (
              <div className="flex flex-col items-center py-8">
                <AlertTriangle className="h-10 w-10 text-red-500" />
                <p className="text-red-700 font-semibold mt-3">Verification Service Unavailable</p>
                <p className="text-sm text-gray-500 mt-1">Please try again later.</p>
              </div>
            )}

            {/* Not Found */}
            {result && !result.found && !loading && (
              <div className="text-center py-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 mb-4">
                  <ShieldAlert className="h-8 w-8 text-red-600" />
                </div>
                <h2 className="text-xl font-bold text-red-700">Not Verified</h2>
                <p className="text-sm text-gray-600 mt-2 max-w-xs mx-auto">
                  This approval code does not match any record in our system.
                  The document may be invalid or the code may have been altered.
                </p>
              </div>
            )}

            {/* Found — Valid */}
            {result && result.found && result.is_valid && !loading && (
              <div>
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-3">
                    <ShieldCheck className="h-8 w-8 text-green-600" />
                  </div>
                  <h2 className="text-xl font-bold text-green-700">Verified & Authentic</h2>
                  <p className="text-sm text-gray-500 mt-1">This approval is genuine and cryptographically verified.</p>
                </div>

                <div className="space-y-3 text-sm">
                  <Row label="Type" value={result.type} />
                  <Row label="Reference" value={result.reference} mono />
                  {result.department && <Row label="Department" value={result.department} capitalize />}
                  <Row label="Status" value={result.status} capitalize />
                  <Row label="Approved On" value={result.approved_on} />
                  <Row label="Approved By" value={result.approved_by} />
                </div>
              </div>
            )}

            {/* Found — Signature Mismatch */}
            {result && result.found && !result.is_valid && !loading && (
              <div>
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 mb-3">
                    <ShieldAlert className="h-8 w-8 text-amber-600" />
                  </div>
                  <h2 className="text-xl font-bold text-amber-700">Signature Mismatch</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    A record exists but the cryptographic signature does not match.
                    The code may have been modified after issuance.
                  </p>
                </div>

                <div className="space-y-3 text-sm">
                  <Row label="Type" value={result.type} />
                  <Row label="Reference" value={result.reference} mono />
                  <Row label="Status" value={result.status} capitalize />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-white/90 text-sm font-semibold">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
          <p className="text-white/60 text-xs mt-1">
            Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034
          </p>
          <p className="text-white/60 text-xs mt-0.5">GST: 33AAACU4245J1ZF</p>
          <p className="text-[#00AE6C] text-xs mt-1 font-medium">www.theworkvilla.com</p>
        </div>
      </main>
    </div>
  );
}

function Row({ label, value, mono, capitalize }: { label: string; value?: string | null; mono?: boolean; capitalize?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className={`font-medium text-gray-900 ${mono ? "font-mono" : ""} ${capitalize ? "capitalize" : ""}`}>
        {value}
      </span>
    </div>
  );
}
