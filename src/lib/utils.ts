import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow, isAfter, isBefore, isToday, isValid } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";
  return format(d, "MMM d, yyyy");
}

export function formatDateTime(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";
  return format(d, "MMM d, yyyy h:mm a");
}

export function formatRelativeDate(date: string | Date): string {
  const d = new Date(date);
  if (!isValid(d)) return "Invalid date";
  return formatDistanceToNow(d, { addSuffix: true });
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
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
