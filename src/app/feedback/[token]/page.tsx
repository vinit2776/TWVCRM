"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Star, CheckCircle2, ThumbsUp, ThumbsDown, Minus } from "lucide-react";

const DIMENSIONS = [
  { key: "space_etiquette",    label: "Cleanliness & Ambiance",   emoji: "🌿", description: "Tidiness, comfort & overall look" },
  { key: "payment_discipline", label: "Service Quality",           emoji: "⭐", description: "Responsiveness & professionalism" },
  { key: "community_behavior", label: "Staff Friendliness",        emoji: "😊", description: "Helpfulness & courtesy of our team" },
  { key: "guest_management",   label: "Facilities & Amenities",    emoji: "🏢", description: "Internet, equipment & common areas" },
  { key: "resource_usage",     label: "Value for Money",           emoji: "💰", description: "Was the experience worth the price?" },
  { key: "renewal_likelihood", label: "Would You Return?",         emoji: "🔄", description: "Likelihood to visit again" },
];

const SENTIMENT_OPTIONS = [
  { id: "great",   label: "Great!",        emoji: "😊", preset: 5, color: "bg-green-50 border-green-400 text-green-800" },
  { id: "okay",    label: "Okay",          emoji: "😐", preset: 3, color: "bg-amber-50 border-amber-400 text-amber-800" },
  { id: "poor",    label: "Needs Work",    emoji: "😞", preset: 2, color: "bg-red-50 border-red-400 text-red-800"  },
];

function getSentiment(avg: number) {
  if (avg >= 4)  return { label: "Positive",  icon: ThumbsUp,   color: "text-green-600", bg: "bg-green-50" };
  if (avg >= 3)  return { label: "Neutral",   icon: Minus,      color: "text-amber-600", bg: "bg-amber-50" };
  return           { label: "Negative",  icon: ThumbsDown, color: "text-red-600",   bg: "bg-red-50"  };
}

export default function PublicFeedbackPage() {
  const { token } = useParams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bookingData, setBookingData] = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [ratings, setRatings]     = useState<Record<string, number>>({});
  const [hovered, setHovered]     = useState<Record<string, number>>({});
  const [notes, setNotes]         = useState("");
  const [sentiment, setSentiment] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res  = await fetch(`/api/public/feedback?token=${token}`);
        const json = await res.json();
        if (!res.ok) { setError(json.error || "Invalid link"); return; }
        if (json.data.already_submitted) setSubmitted(true);
        setBookingData(json.data);
      } catch {
        setError("Failed to load feedback form");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token]);

  const handleSentiment = (id: string, preset: number) => {
    setSentiment(id);
    const all: Record<string, number> = {};
    DIMENSIONS.forEach(d => { all[d.key] = preset; });
    setRatings(all);
  };

  const handleStar = (key: string, value: number) => {
    setRatings(prev => ({ ...prev, [key]: value }));
  };

  const avgRating = () => {
    const vals = Object.values(ratings).filter(v => v > 0);
    if (vals.length === 0) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const handleSubmit = async () => {
    if (Object.keys(ratings).length === 0) return;
    setSubmitting(true);
    try {
      const res  = await fetch("/api/public/feedback", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ token, ...ratings, notes }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Failed to submit"); return; }
      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Loading ─────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin h-10 w-10 border-[3px] border-[#015E65] border-t-transparent rounded-full" />
    </div>
  );

  if (error && !bookingData) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-2xl shadow-md p-8 max-w-sm w-full text-center">
        <div className="text-4xl mb-3">🔗</div>
        <h2 className="text-lg font-semibold text-gray-800 mb-1">Link Unavailable</h2>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    </div>
  );

  const avg = avgRating();
  const hasRatings = Object.keys(ratings).length > 0;

  // ─── Thank You Screen ────────────────────────────────────────────────────
  if (submitted) {
    const submittedAvg = avg > 0 ? avg : 3;
    const s = getSentiment(submittedAvg);
    const SIcon = s.icon;

    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-sm w-full">
          {/* Brand header */}
          <div className="bg-[#015E65] text-white rounded-t-2xl p-5 text-center">
            <p className="font-bold text-lg tracking-wide">The WorkVilla</p>
          </div>

          <div className="bg-white rounded-b-2xl shadow-md p-8 text-center space-y-4">
            <CheckCircle2 className="h-14 w-14 text-green-500 mx-auto" />
            <h2 className="text-2xl font-bold text-gray-900">Thank You!</h2>
            <p className="text-gray-500 text-sm">Your feedback has been recorded.</p>

            {submittedAvg > 0 && (
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold ${s.bg} ${s.color}`}>
                <SIcon className="h-4 w-4" />
                {s.label} Experience
              </div>
            )}

            <div className="pt-2 text-xs text-gray-400 space-y-1">
              <p>Booking #{bookingData?.booking_number}</p>
              <p>{bookingData?.space_name}</p>
            </div>

            {submittedAvg >= 4 && (
              <p className="text-sm text-gray-600 pt-2">
                We&apos;re delighted you had a great time. See you again at The WorkVilla! 🙌
              </p>
            )}
            {submittedAvg < 3 && (
              <p className="text-sm text-gray-600 pt-2">
                We&apos;re sorry to hear that. Your feedback helps us do better — thank you for being honest.
              </p>
            )}
          </div>

          <p className="text-center text-xs text-gray-400 mt-4">
            The WorkVilla · Prakash Presidium, 110 MG Road, Chennai 600034
          </p>
        </div>
      </div>
    );
  }

  const positiveComment = sentiment === "great";

  // ─── Feedback Form ───────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 p-4 pb-10">
      <div className="max-w-lg mx-auto">

        {/* Brand header */}
        <div className="bg-[#015E65] text-white rounded-t-2xl p-5 text-center">
          <h1 className="font-bold text-xl">The WorkVilla</h1>
          <p className="text-[#00AE6C] text-xs mt-1">We value your feedback</p>
        </div>

        <div className="bg-white rounded-b-2xl shadow-md">

          {/* Booking info */}
          <div className="bg-gray-50 mx-4 mt-4 rounded-xl p-4 border border-gray-100">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Your Booking</p>
            <p className="font-semibold text-gray-800">{bookingData?.space_name}</p>
            <p className="text-sm text-gray-500">
              {bookingData?.booking_date} &nbsp;·&nbsp;
              {bookingData?.start_time?.slice(0, 5)} – {bookingData?.end_time?.slice(0, 5)}
            </p>
            <p className="text-xs text-gray-400 mt-1">#{bookingData?.booking_number}</p>
          </div>

          <div className="p-5 space-y-6">

            {/* Greeting */}
            <div>
              <p className="font-semibold text-gray-800 text-base">
                Hi {bookingData?.customer_name?.split(" ")[0] || "there"} 👋
              </p>
              <p className="text-sm text-gray-500 mt-0.5">
                How was your experience with us today?
              </p>
            </div>

            {/* Quick sentiment selector */}
            <div className="grid grid-cols-3 gap-2">
              {SENTIMENT_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => handleSentiment(opt.id, opt.preset)}
                  className={`flex flex-col items-center gap-1 py-3 rounded-xl border-2 transition-all text-sm font-medium ${
                    sentiment === opt.id
                      ? opt.color + " shadow-sm scale-105"
                      : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <span className="text-2xl">{opt.emoji}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-100" />
              <span className="text-xs text-gray-400">Rate each aspect</span>
              <div className="flex-1 h-px bg-gray-100" />
            </div>

            {/* Per-dimension ratings */}
            <div className="space-y-4">
              {DIMENSIONS.map(dim => {
                const val  = ratings[dim.key] || 0;
                const hov  = hovered[dim.key] || 0;
                const show = hov || val;
                return (
                  <div key={dim.key}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div>
                        <span className="text-sm font-medium text-gray-800">
                          {dim.emoji} {dim.label}
                        </span>
                        <p className="text-xs text-gray-400">{dim.description}</p>
                      </div>
                      {val > 0 && (
                        <span className="text-xs font-semibold text-[#015E65]">{val}/5</span>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {[1, 2, 3, 4, 5].map(star => (
                        <button
                          key={star}
                          onClick={() => handleStar(dim.key, star)}
                          onMouseEnter={() => setHovered(p => ({ ...p, [dim.key]: star }))}
                          onMouseLeave={() => setHovered(p => ({ ...p, [dim.key]: 0 }))}
                          className="p-0.5 transition-transform hover:scale-110 active:scale-95"
                        >
                          <Star
                            className={`w-8 h-8 transition-colors ${
                              show >= star
                                ? "fill-amber-400 text-amber-400"
                                : "fill-none text-gray-200"
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Comments */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {positiveComment
                  ? "What did you love most? (optional)"
                  : sentiment === "poor"
                    ? "How can we improve? (optional)"
                    : "Any additional comments? (optional)"}
              </label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder={
                  positiveComment
                    ? "e.g. Great ambiance, helpful staff..."
                    : "Tell us more..."
                }
                className="w-full border border-gray-200 rounded-xl p-3 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-[#015E65] focus:border-transparent resize-none"
              />
            </div>

            {error && (
              <p className="text-red-500 text-sm bg-red-50 p-3 rounded-lg">{error}</p>
            )}

            {/* Submit */}
            <button
              onClick={handleSubmit}
              disabled={submitting || !hasRatings}
              className="w-full bg-[#015E65] text-white py-3.5 rounded-xl font-semibold text-base hover:bg-[#014a50] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Submitting...
                </span>
              ) : "Submit Feedback"}
            </button>

            <button
              onClick={() => setSubmitted(true)}
              className="w-full text-gray-400 text-sm py-2 hover:text-gray-600 transition-colors"
            >
              Skip for now
            </button>

          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4 px-4">
          The WorkVilla · Prakash Presidium, 110 MG Road, Nungambakkam, Chennai 600034
        </p>
      </div>
    </div>
  );
}
