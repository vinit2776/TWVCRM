"use client";

import { useState } from "react";
import { preventEnterSubmit } from "@/lib/utils";

export default function EnquirePage() {
  // Form state — only fields shown on this form
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [hpField, setHpField] = useState(""); // honeypot

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Client-side honeypot: silently succeed
    if (hpField) {
      setSubmitted(true);
      return;
    }

    // Validate only the displayed fields
    if (!name.trim()) { setError("Please enter your full name."); return; }
    if (!/^[6-9]\d{9}$/.test(mobile)) { setError("Please enter a valid 10-digit mobile number."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/public/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          mobile: mobile.trim(),
          email: email.trim() || undefined,
          hp_field: hpField,
          source: "google_ads",
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Something went wrong. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#015E65] text-white py-5 px-6 shadow-md">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="flex-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-white.png" alt="The WorkVilla" className="h-9" />
            <p className="text-[#7fd8c2] text-sm mt-1">Premium Coworking Spaces in Chennai</p>
          </div>
          <span className="hidden sm:inline-block text-xs bg-[#014a50] px-3 py-1.5 rounded-full font-medium">
            Get a Free Seat Trial
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-3xl mx-auto px-4 py-8">
        {submitted ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h2 className="text-2xl font-bold text-[#015E65]">Thank You!</h2>
            <p className="text-gray-600 mt-2 text-base">
              Our team will contact you within <span className="font-semibold text-gray-800">24 hours</span>.
            </p>
            <p className="text-gray-400 text-sm mt-4">
              We look forward to helping you find the perfect workspace.
            </p>
            <div className="mt-6 pt-6 border-t border-gray-100">
              <p className="text-xs text-gray-400">
                The WorkVilla · Prakash Presidium, 110 MG Road, Nungambakkam, Chennai 600034
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-2xl font-bold text-gray-900">Enquire Now</h2>
                <span className="text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                  Google Ads
                </span>
              </div>
              <p className="text-gray-500 text-sm">
                Tell us what you&apos;re looking for and we&apos;ll get back to you shortly.
              </p>
            </div>

            <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} noValidate>
              {/* Honeypot — hidden from real users */}
              <div className="hidden" aria-hidden="true">
                <input
                  type="text"
                  name="website_url"
                  tabIndex={-1}
                  autoComplete="off"
                  value={hpField}
                  onChange={(e) => setHpField(e.target.value)}
                />
              </div>

              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
                {/* Row 1: Name + Mobile */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Full Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Rahul Sharma"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Mobile Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
                      placeholder="9876543210"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                    />
                  </div>
                </div>

                {/* Row 2: Email (full width) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="rahul@company.com"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                  />
                </div>

                {error && (
                  <p className="text-red-500 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-[#015E65] text-white py-3 rounded-lg font-semibold text-sm hover:bg-[#014a50] active:bg-[#013d43] disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
                >
                  {submitting ? (
                    <>
                      <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Enquiry"
                  )}
                </button>

                <p className="text-center text-xs text-gray-400">
                  By submitting, you agree to be contacted by The WorkVilla team.
                </p>
              </div>
            </form>
          </>
        )}

        <p className="text-center text-xs text-gray-400 mt-6">
          The WorkVilla · Prakash Presidium, 110 MG Road, Nungambakkam, Chennai 600034
        </p>
      </div>
    </div>
  );
}
