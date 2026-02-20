"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Star } from "lucide-react";

const DIMENSIONS = [
  { key: "space_etiquette", label: "Space Etiquette", description: "How was the cleanliness and ambiance?" },
  { key: "payment_discipline", label: "Service Quality", description: "How would you rate our service?" },
  { key: "community_behavior", label: "Staff Behavior", description: "How was the staff's responsiveness?" },
  { key: "guest_management", label: "Facilities", description: "How were the facilities provided?" },
  { key: "resource_usage", label: "Value for Money", description: "Was the experience worth the price?" },
  { key: "renewal_likelihood", label: "Would You Return?", description: "How likely are you to book again?" },
];

export default function PublicFeedbackPage() {
  const { token } = useParams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bookingData, setBookingData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/public/feedback?token=${token}`);
        const json = await res.json();
        if (!res.ok) { setError(json.error || "Invalid link"); return; }
        if (json.data.already_submitted) { setSubmitted(true); }
        setBookingData(json.data);
      } catch {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...ratings, notes }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error); return; }
      setSubmitted(true);
    } catch {
      setError("Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin h-8 w-8 border-2 border-[#015E65] border-t-transparent rounded-full" />
    </div>
  );

  if (error && !bookingData) return (
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
          <p className="text-[#00AE6C] text-sm mt-1">We value your feedback</p>
        </div>

        <div className="bg-white rounded-b-xl shadow p-6">
          {submitted ? (
            <div className="text-center py-8">
              <div className="text-5xl mb-4">🙏</div>
              <h2 className="text-xl font-bold text-[#015E65]">Thank You!</h2>
              <p className="text-gray-600 mt-2">Your feedback has been submitted successfully.</p>
              <p className="text-gray-400 text-sm mt-4">Booking: {bookingData?.booking_number}</p>
            </div>
          ) : (
            <>
              {/* Booking Info */}
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <p className="text-sm text-gray-500">Booking #{bookingData?.booking_number}</p>
                <p className="font-semibold text-gray-800">{bookingData?.space_name}</p>
                <p className="text-sm text-gray-600">
                  {bookingData?.booking_date} · {bookingData?.start_time?.slice(0, 5)} – {bookingData?.end_time?.slice(0, 5)}
                </p>
              </div>

              <p className="text-gray-600 mb-4">Dear {bookingData?.customer_name}, please rate your experience:</p>

              {/* Rating Dimensions */}
              {DIMENSIONS.map(dim => (
                <div key={dim.key} className="mb-5">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-medium text-sm text-gray-800">{dim.label}</span>
                    <span className="text-xs text-gray-400">{dim.description}</span>
                  </div>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(star => (
                      <button
                        key={star}
                        onClick={() => setRatings(prev => ({ ...prev, [dim.key]: star }))}
                        className="p-1"
                      >
                        <Star
                          className={`w-7 h-7 ${(ratings[dim.key] || 0) >= star ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {/* Notes */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-1">Additional Comments</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  className="w-full border rounded-lg p-3 text-sm focus:ring-[#015E65] focus:border-[#015E65]"
                  placeholder="Tell us more about your experience..."
                />
              </div>

              {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

              <button
                onClick={handleSubmit}
                disabled={submitting || Object.keys(ratings).length === 0}
                className="w-full bg-[#015E65] text-white py-3 rounded-lg font-semibold hover:bg-[#014a50] disabled:opacity-50 transition-colors"
              >
                {submitting ? "Submitting..." : "Submit Feedback"}
              </button>
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
