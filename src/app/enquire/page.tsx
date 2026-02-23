"use client";

import { useEffect, useState } from "react";

const WORKSPACE_TYPES = [
  { value: "hot_desk", label: "Hot Desk" },
  { value: "dedicated_desk", label: "Dedicated Desk" },
  { value: "private_office", label: "Private Office / Cabin" },
  { value: "meeting_room", label: "Meeting Room" },
  { value: "conference_room", label: "Conference Room" },
  { value: "virtual_office", label: "Virtual Office" },
];

interface Location {
  id: string;
  name: string;
}

export default function EnquirePage() {
  const [locations, setLocations] = useState<Location[]>([]);

  // Form state
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [workspaceType, setWorkspaceType] = useState("");
  const [seatCapacity, setSeatCapacity] = useState("");
  const [budgetPerSeat, setBudgetPerSeat] = useState("");
  const [preferredLocation, setPreferredLocation] = useState("");
  const [workingHours, setWorkingHours] = useState("");
  const [description, setDescription] = useState("");
  const [hpField, setHpField] = useState(""); // honeypot

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/public/locations")
      .then((r) => r.json())
      .then((json) => {
        if (json.data) setLocations(json.data);
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Client-side honeypot: silently succeed
    if (hpField) {
      setSubmitted(true);
      return;
    }

    if (!name.trim()) { setError("Please enter your full name."); return; }
    if (!mobile.trim()) { setError("Please enter your mobile number."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/public/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          mobile: mobile.trim(),
          email: email.trim() || undefined,
          company: company.trim() || undefined,
          workspace_type: workspaceType || undefined,
          seat_capacity: seatCapacity ? seatCapacity : undefined,
          budget_per_seat: budgetPerSeat ? budgetPerSeat : undefined,
          preferred_location: preferredLocation || undefined,
          working_hours: workingHours.trim() || undefined,
          description: description.trim() || undefined,
          hp_field: hpField,
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
            <h1 className="text-xl font-bold tracking-tight">The WorkVilla</h1>
            <p className="text-[#7fd8c2] text-sm mt-0.5">Premium Coworking Spaces in Chennai</p>
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
              <h2 className="text-2xl font-bold text-gray-900">Enquire Now</h2>
              <p className="text-gray-500 mt-1 text-sm">
                Tell us what you&apos;re looking for and we&apos;ll get back to you shortly.
              </p>
            </div>

            <form onSubmit={handleSubmit} noValidate>
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
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Mobile Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      placeholder="+91 98765 43210"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                      required
                    />
                  </div>
                </div>

                {/* Row 2: Email + Company */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
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
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Company Name
                    </label>
                    <input
                      type="text"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      placeholder="Acme Pvt. Ltd."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                    />
                  </div>
                </div>

                {/* Row 3: Workspace Type + Seats */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      I&apos;m Looking For
                    </label>
                    <select
                      value={workspaceType}
                      onChange={(e) => setWorkspaceType(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent bg-white"
                    >
                      <option value="">Select workspace type</option>
                      {WORKSPACE_TYPES.map((wt) => (
                        <option key={wt.value} value={wt.value}>
                          {wt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Number of Seats
                    </label>
                    <input
                      type="number"
                      value={seatCapacity}
                      onChange={(e) => setSeatCapacity(e.target.value)}
                      placeholder="e.g. 5"
                      min={1}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                    />
                  </div>
                </div>

                {/* Row 4: Budget + Location */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Monthly Budget / Seat (₹)
                    </label>
                    <input
                      type="number"
                      value={budgetPerSeat}
                      onChange={(e) => setBudgetPerSeat(e.target.value)}
                      placeholder="e.g. 7000"
                      min={1}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Preferred Location
                    </label>
                    {locations.length > 0 ? (
                      <select
                        value={preferredLocation}
                        onChange={(e) => setPreferredLocation(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent bg-white"
                      >
                        <option value="">Any location</option>
                        {locations.map((loc) => (
                          <option key={loc.id} value={loc.name}>
                            {loc.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={preferredLocation}
                        onChange={(e) => setPreferredLocation(e.target.value)}
                        placeholder="e.g. Nungambakkam"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                      />
                    )}
                  </div>
                </div>

                {/* Row 5: Working Hours (full width) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Working Hours / Shift Timings
                  </label>
                  <input
                    type="text"
                    value={workingHours}
                    onChange={(e) => setWorkingHours(e.target.value)}
                    placeholder="e.g. Mon–Fri, 9 AM to 6 PM"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent"
                  />
                </div>

                {/* Row 6: Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tell Us Your Requirement
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    placeholder="Any specific requirements, questions, or details about your workspace needs..."
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent resize-none"
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
