import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow, isAfter, isBefore, isToday, isValid } from "date-fns";
import type { KeyboardEvent } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Browsers submit a <form> when Enter is pressed in any single-line input,
// even ones that are just one field among many (e.g. a line-item's quantity
// box). That silently saves and closes create/edit dialogs before the user
// meant to submit. Textareas and buttons are left alone — a textarea's Enter
// never auto-submits, and a focused button (e.g. the real Save button) should
// still respond to Enter.
export function preventEnterSubmit(e: KeyboardEvent<HTMLFormElement>) {
  const target = e.target as HTMLElement;
  if (e.key === "Enter" && target.tagName !== "TEXTAREA" && target.tagName !== "BUTTON") {
    e.preventDefault();
  }
}

export function formatDate(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";
  return format(d, "MMM d, yyyy");
}

export function formatDateTime(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";
  // Always display in IST (Asia/Kolkata, UTC+5:30) regardless of the
  // browser/server's local timezone — timestamps are stored in UTC.
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/**
 * Converts a naive "yyyy-MM-ddTHH:mm" string — what FollowUpDateTimeInput and
 * <input type="datetime-local"> produce, always meant as IST wall-clock time
 * for this business — into a correct UTC ISO timestamp for a TIMESTAMPTZ
 * column. Without this, Postgres's timestamptz parser (session timezone
 * UTC) stores the naive H:mm as if it were already UTC, and formatDateTime()
 * then re-adds the IST offset on display — every follow-up silently lands
 * 5:30 later than the time actually picked. Returns "" unchanged so callers
 * can pass through an empty/optional value.
 */
export function istLocalToUtcIso(naiveLocal: string): string {
  if (!naiveLocal) return naiveLocal;
  return new Date(`${naiveLocal}:00+05:30`).toISOString();
}

/**
 * Formats a date for use as the `value` of an `<input type="datetime-local">`
 * (expects "yyyy-MM-ddTHH:mm" in the browser's local timezone). Falls back to
 * the current time if the input is missing/invalid, so reschedule dialogs
 * always open with a sane default.
 */
export function toDatetimeLocalValue(date?: string | Date | null): string {
  const d = date ? new Date(date) : new Date();
  if (!isValid(d)) return format(new Date(), "yyyy-MM-dd'T'HH:mm");
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

export function formatRelativeDate(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";
  return formatDistanceToNow(d, { addSuffix: true });
}

/**
 * Smart date: "Today, 10:42 AM" / "Yesterday, 3:15 PM" / "03 May" (same year) /
 * "03 May 2025" (older year). Useful for activity feeds + audit columns where
 * recent timestamps deserve the time-of-day but older ones just need the date.
 */
export function formatSmartDate(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const time = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);

  if (dDay.getTime() === today.getTime()) return `Today, ${time}`;
  if (dDay.getTime() === yesterday.getTime()) return `Yesterday, ${time}`;

  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function getMonthDateRange(year: number, month: number): { from: string; to: string } {
  // Build the date strings from local calendar fields directly — going through
  // toISOString() (UTC) would shift the date backward by a day in timezones ahead of
  // UTC (e.g. IST), silently rolling the range into the previous month.
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function isOverdue(date: string | Date): boolean {
  return isBefore(new Date(date), new Date()) && !isToday(new Date(date));
}

export function isDueToday(date: string | Date): boolean {
  return isToday(new Date(date));
}

export function isDueSoon(date: string | Date): boolean {
  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
  return isAfter(new Date(date), new Date()) && isBefore(new Date(date), threeDaysFromNow);
}

export function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Masks a voucher code for display, e.g. "81346-46018" -> "813**-****8"
 */
export function maskVoucherCode(code: string): string {
  if (code.length <= 4) return code.replace(/./g, "*");
  const parts = code.split("-");
  if (parts.length === 2) {
    const left = parts[0].slice(0, 3) + "*".repeat(Math.max(0, parts[0].length - 3));
    const right = "*".repeat(Math.max(0, parts[1].length - 1)) + parts[1].slice(-1);
    return `${left}-${right}`;
  }
  // Fallback: show first 3 and last 1
  return code.slice(0, 3) + "*".repeat(code.length - 4) + code.slice(-1);
}

/**
 * Returns a human-readable label for a validity_days value.
 * Converts days to months/years when applicable for better readability.
 */
export function getValidityLabel(days: number | null | undefined): string {
  if (days == null) return "Unclassified";
  if (days > 0 && days < 1) {
    const hours = Math.round(days * 24);
    return hours === 1 ? "1 Hour" : `${hours} Hours`;
  }
  if (days === 1) return "1 Day";
  if (days === 7) return "7 Days";
  if (days % 365 === 0 && days >= 365) {
    const years = days / 365;
    return years === 1 ? "1 Year (365d)" : `${years} Years (${days}d)`;
  }
  if (days % 30 === 0 && days >= 30) {
    const months = days / 30;
    return months === 1 ? "1 Month (30d)" : `${months} Months (${days}d)`;
  }
  return `${days} Days`;
}

/**
 * Coerce an API error payload's `error` field into a string safe for toasts.
 * Some routes return Zod fieldErrors objects in `error` — rendering an object
 * as a React child crashes the whole app, so never pass `json.error` to a
 * toast directly; route it through this helper.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const parts = Object.entries(error as Record<string, unknown>)
      .map(([field, v]) => `${field}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    if (parts.length) return parts.join("; ");
  }
  return fallback;
}
