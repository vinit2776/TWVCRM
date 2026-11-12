"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus, CalendarClock, Search, X, ChevronLeft, ChevronRight,
  LogIn, LogOut, XCircle, MoreHorizontal, Mail, AlertTriangle, Phone,
  Star, MessageSquareWarning, Calendar, BarChart3, List, Copy, RotateCcw,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { useLocations } from "@/hooks/use-locations";
import { formatDate, formatCurrency, bookingWindowHours } from "@/lib/utils";
import {
  BOOKING_STATUSES, BOOKING_STATUS_LABELS, BOOKING_STATUS_COLORS,
  BOOKING_CUSTOMER_TYPES, BOOKING_CUSTOMER_TYPE_LABELS, BOOKING_CUSTOMER_TYPE_COLORS,
  BOOKING_PAYMENT_STATUS_LABELS, BOOKING_PAYMENT_STATUS_COLORS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { Booking } from "@/types";
import { CalendarView } from "@/components/bookings/calendar-view";
import { BookingCountdown } from "@/components/bookings/booking-countdown";
import { BulkActionsBar } from "@/components/bookings/bulk-actions-bar";
import dynamic from "next/dynamic";
import { CustomerSegments } from "@/components/bookings/customer-segments";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

// Recharts is ~200 KB gzipped. Lazy-load the two chart-heavy components so the
// Analytics tab only pulls them in when the user actually opens it.
const UtilizationDashboard = dynamic(
  () => import("@/components/bookings/utilization-dashboard").then((m) => m.UtilizationDashboard),
  { ssr: false, loading: () => <div className="h-64 rounded-md bg-muted animate-pulse" /> }
);
const RevenueReport = dynamic(
  () => import("@/components/bookings/revenue-report").then((m) => m.RevenueReport),
  { ssr: false, loading: () => <div className="h-64 rounded-md bg-muted animate-pulse" /> }
);

function formatTime12(timeStr: string): string {
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// check_in_at / check_out_at are full ISO timestamps (unlike start_time /
// end_time, which are bare "HH:MM:SS" slot strings) — always render in IST
// regardless of the browser/server's local timezone.
function formatActualTime12(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function actualUsageDuration(checkInAt: string, checkOutAt: string): string {
  const minutes = Math.max(0, Math.round((new Date(checkOutAt).getTime() - new Date(checkInAt).getTime()) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function isBookingPastStartTime(b: Booking): boolean {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  if (b.booking_date !== today) return false;
  const [bh, bm] = b.start_time.slice(0, 5).split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() > bh * 60 + bm;
}

function copyBookingDetails(b: Booking) {
  const customerName = b.lead
    ? `${b.lead.first_name} ${b.lead.last_name}`
    : b.guest_name || "Guest";
  const customerPhone = b.booker_phone || b.guest_phone || b.lead?.phone || "";
  const company = b.lead?.company || b.guest_company || "";

  const lines: string[] = [
    `Booking Confirmation - ${b.booking_number}`,
    ``,
    `Date: ${formatDate(b.booking_date)}`,
    `Time: ${formatTime12(b.start_time)} - ${formatTime12(b.end_time)} (${(() => {
      const h = bookingWindowHours(b.start_time, b.end_time);
      return Number.isInteger(h) ? h : h.toFixed(1).replace(/\.0$/, "");
    })()}h)`,
    `Space: ${b.space?.name || "—"}`,
    `Location: ${b.location?.name || "—"}`,
  ];

  lines.push(``);
  lines.push(`Customer: ${customerName}`);
  if (company) lines.push(`Company: ${company}`);
  if (customerPhone) lines.push(`Phone: ${customerPhone}`);
  if (b.lead?.email || b.guest_email) lines.push(`Email: ${b.lead?.email || b.guest_email}`);

  lines.push(``);
  lines.push(`Amount: ${formatCurrency(b.total_amount)}${b.gst_amount ? ` + ${formatCurrency(b.gst_amount)} GST = ${formatCurrency(b.total_amount_with_gst || b.total_amount + b.gst_amount)}` : ""}`);
  lines.push(`Payment: ${BOOKING_PAYMENT_STATUS_LABELS[b.payment_status]}`);
  lines.push(`Status: ${BOOKING_STATUS_LABELS[b.status]}`);

  if (b.facilities && b.facilities.length > 0) {
    lines.push(``);
    lines.push(`Add-ons: ${b.facilities.map(f => f.facility_name).join(", ")}`);
  }

  lines.push(``);
  lines.push(`Booking Type: ${BOOKING_CUSTOMER_TYPE_LABELS[b.customer_type]}`);
  if (b.contract?.contract_number) {
    lines.push(`Agreement: ${b.contract.contract_number}`);
  }

  navigator.clipboard.writeText(lines.join("\n")).then(() => {
    toast.success("Booking details copied to clipboard");
  }).catch(() => {
    toast.error("Failed to copy details");
  });
}

type TabType = "list" | "calendar" | "analytics";

interface BookingTableProps {
  bookings: Booking[];
  title: string;
  icon?: React.ReactNode;
  search: string;
  setSearch: (s: string) => void;
  searchPlaceholder: string;
  onStatusAction: (id: string, action: string) => void;
  onResendEmail: (id: string) => void;
  router: ReturnType<typeof useRouter>;
  emptyMessage: string;
  blinkUncheckedIn?: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
}

function BookingTable({
  bookings, title, icon, search, setSearch, searchPlaceholder,
  onStatusAction, onResendEmail, router, emptyMessage, blinkUncheckedIn,
  selectedIds, onToggleSelect, onSelectAll,
}: BookingTableProps) {
  // Filter by phone / name search
  const filtered = bookings.filter(b => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    const customerName = b.lead
      ? `${b.lead.first_name} ${b.lead.last_name}`.toLowerCase()
      : (b.guest_name || "").toLowerCase();
    const phone = (b.booker_phone || b.guest_phone || b.lead?.phone || "").toLowerCase();
    const bookingNum = (b.booking_number || "").toLowerCase();
    return customerName.includes(q) || phone.includes(q) || bookingNum.includes(q);
  });

  const allSelected = filtered.length > 0 && filtered.every(b => selectedIds.has(b.id));

  const handleReBook = async (bookingId: string) => {
    try {
      const res = await fetch(`/api/bookings/${bookingId}/rebook-data`);
      if (res.ok) {
        const json = await res.json();
        const d = json.data;
        const params = new URLSearchParams();
        if (d.space_id)       params.set("space_id",      d.space_id);
        if (d.customer_type)  params.set("customer_type", d.customer_type);
        if (d.lead_id)        params.set("lead_id",       d.lead_id);
        if (d.booker_phone)   params.set("booker_phone",  d.booker_phone);
        if (d.contract_id)    params.set("contract_id",   d.contract_id);
        router.push(`/bookings/new?${params}`);
      } else {
        toast.error("Failed to load booking data");
      }
    } catch {
      toast.error("Failed to load booking data");
    }
  };

  const handleCopyLink = (bookingId: string) => {
    const url = `${window.location.origin}/bookings/${bookingId}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success("Booking link copied to clipboard");
    }).catch(() => {
      toast.error("Failed to copy link");
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {icon}
            {title}
            <Badge variant="secondary" className="text-xs ml-1">{filtered.length}</Badge>
          </CardTitle>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-[200px] h-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-t border-b bg-muted/50">
                <th className="px-2 py-2.5 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => {
                      if (allSelected) {
                        filtered.forEach(b => selectedIds.has(b.id) && onToggleSelect(b.id));
                      } else {
                        onSelectAll(filtered.map(b => b.id));
                      }
                    }}
                    className="h-3.5 w-3.5 rounded border-gray-300"
                  />
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-xs">Booking #</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs hidden md:table-cell">Space</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs hidden xl:table-cell">Location</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs">Time</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs">Customer</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs hidden lg:table-cell">Phone</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs hidden md:table-cell">Type</th>
                <th className="px-4 py-2.5 text-right font-medium text-xs hidden sm:table-cell">Amount</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs hidden lg:table-cell">Payment</th>
                <th className="px-4 py-2.5 text-left font-medium text-xs">Status</th>
                <th className="px-4 py-2.5 text-right font-medium text-xs">Actions</th>
              </tr></thead>
              <tbody>{filtered.map((b) => {
                const customerName = b.lead
                  ? `${b.lead.first_name} ${b.lead.last_name}`
                  : b.guest_name || "Guest";
                const customerPhone = b.booker_phone || b.guest_phone || b.lead?.phone || "";
                const shouldBlink = blinkUncheckedIn && b.status === "confirmed" && isBookingPastStartTime(b);

                return (
                  <tr
                    key={b.id}
                    className={`border-b hover:bg-muted/30 transition-colors cursor-pointer ${
                      shouldBlink ? "animate-pulse bg-amber-50" : ""
                    } ${selectedIds.has(b.id) ? "bg-blue-50/50" : ""}`}
                    onClick={() => {
                      pushTrailEntry({ href: `/bookings/${b.id}`, label: b.booking_number });
                      router.push(`/bookings/${b.id}`);
                    }}
                  >
                    <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(b.id)}
                        onChange={() => onToggleSelect(b.id)}
                        className="h-3.5 w-3.5 rounded border-gray-300"
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {shouldBlink && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
                        <span className="font-mono text-xs">{b.booking_number}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell text-xs">{b.space?.name || "—"}</td>
                    <td className="px-4 py-2.5 hidden xl:table-cell text-xs text-muted-foreground">{b.location?.name || "—"}</td>
                    <td className="px-4 py-2.5">
                      <div className="text-xs">{formatTime12(b.start_time)} – {formatTime12(b.end_time)}</div>
                      {b.check_in_at && (
                        <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5 flex items-center gap-1">
                          <LogIn className="h-3 w-3 shrink-0" />
                          {formatActualTime12(b.check_in_at)}
                          {b.check_out_at ? (
                            <>
                              <LogOut className="h-3 w-3 shrink-0 ml-0.5" />
                              {formatActualTime12(b.check_out_at)}
                              <span className="text-muted-foreground">({actualUsageDuration(b.check_in_at, b.check_out_at)})</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">(in progress)</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{customerName}</td>
                    <td className="px-4 py-2.5 hidden lg:table-cell">
                      {customerPhone && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" />
                          {customerPhone}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell">
                      <Badge variant="outline" className={`text-[10px] ${BOOKING_CUSTOMER_TYPE_COLORS[b.customer_type]}`}>
                        {BOOKING_CUSTOMER_TYPE_LABELS[b.customer_type]}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-xs hidden sm:table-cell">{formatCurrency(b.total_amount_with_gst || b.total_amount + (b.gst_amount || 0))}</td>
                    <td className="px-4 py-2.5 hidden lg:table-cell">
                      <Badge variant="secondary" className={`text-[10px] ${BOOKING_PAYMENT_STATUS_COLORS[b.payment_status]}`}>
                        {BOOKING_PAYMENT_STATUS_LABELS[b.payment_status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className={`text-[10px] ${BOOKING_STATUS_COLORS[b.status]}`}>
                          {BOOKING_STATUS_LABELS[b.status]}
                        </Badge>
                        {b.status === "checked_out" && (
                          Array.isArray(b.feedback) && b.feedback.length > 0
                            ? <span title="Feedback submitted"><Star className="h-3 w-3 fill-green-500 text-green-500" /></span>
                            : <span title="Feedback pending"><MessageSquareWarning className="h-3 w-3 text-amber-500" /></span>
                        )}
                        {b.facility_resolution === "unresolved" && (
                          <span title="Multiple facility quotas on this contract, none matched the room booked — needs manual review to attribute the right quota">
                            <AlertTriangle className="h-3 w-3 text-amber-500" />
                          </span>
                        )}
                        {b.facility_resolution === "override" && (
                          <span title={`Substitute allocation${b.facility_override_reason ? `: ${b.facility_override_reason}` : ""}`}>
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-purple-50 text-purple-700 border-purple-200">Substitute</Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {b.status === "confirmed" && (
                            <>
                              <DropdownMenuItem onClick={() => onStatusAction(b.id, "check_in")}>
                                <LogIn className="mr-2 h-4 w-4" />Check In
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onStatusAction(b.id, "no_show")}>
                                <AlertTriangle className="mr-2 h-4 w-4" />No Show
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onStatusAction(b.id, "cancel")} className="text-destructive">
                                <XCircle className="mr-2 h-4 w-4" />Cancel
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onResendEmail(b.id)}>
                                <Mail className="mr-2 h-4 w-4" />Resend Email
                              </DropdownMenuItem>
                            </>
                          )}
                          {b.status === "checked_in" && (
                            <DropdownMenuItem onClick={() => onStatusAction(b.id, "check_out")}>
                              <LogOut className="mr-2 h-4 w-4" />Check Out
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleReBook(b.id)}>
                            <RotateCcw className="mr-2 h-4 w-4" />Book Again
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleCopyLink(b.id)}>
                            <Copy className="mr-2 h-4 w-4" />Copy Link
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => copyBookingDetails(b)}>
                            <Share2 className="mr-2 h-4 w-4" />Copy Booking Details
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function BookingsPage() {
  const router = useRouter();
  const { locations } = useLocations();
  const [allBookings, setAllBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState("");
  const [activeTab, setActiveTab] = useState<TabType>("list");

  // Per-table search states
  const [todayUpcomingSearch, setTodayUpcomingSearch] = useState("");
  const [todayCompletedSearch, setTodayCompletedSearch] = useState("");
  const [futureSearch, setFutureSearch] = useState("");

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // For the "All Bookings" fallback section
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [customerTypeFilter, setCustomerTypeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [allSearch, setAllSearch] = useState("");
  const [allBookingsList, setAllBookingsList] = useState<Booking[]>([]);
  const [allPagination, setAllPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [allLoading, setAllLoading] = useState(false);
  const [showAllBookings, setShowAllBookings] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = (ids: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });
  };

  // Fetch today and future bookings (all at once for the dashboard view)
  const fetchDashboardBookings = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "50", date_from: today });
    if (locationFilter) params.set("location_id", locationFilter);
    try {
      const res = await fetch(`/api/bookings?${params}`);
      if (res.ok) {
        const json = await res.json();
        setAllBookings(json.data || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [today, locationFilter]);

  useEffect(() => { fetchDashboardBookings(); }, [fetchDashboardBookings]);

  // Fetch "all bookings" when the section is visible (for history browsing)
  const fetchAllBookings = useCallback(async () => {
    setAllLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25", include_history: "true" });
    if (locationFilter) params.set("location_id", locationFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (customerTypeFilter) params.set("customer_type", customerTypeFilter);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (allSearch.trim()) params.set("search", allSearch.trim());
    try {
      const res = await fetch(`/api/bookings?${params}`);
      if (res.ok) {
        const json = await res.json();
        setAllBookingsList(json.data || []);
        setAllPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
      }
    } catch { /* ignore */ }
    setAllLoading(false);
  }, [page, locationFilter, statusFilter, customerTypeFilter, dateFrom, dateTo, allSearch]);

  useEffect(() => {
    if (showAllBookings) fetchAllBookings();
  }, [showAllBookings, fetchAllBookings]);

  // Split bookings into categories
  const todayUpcoming = allBookings.filter(b =>
    b.booking_date === today && (b.status === "confirmed" || b.status === "checked_in")
  );
  const todayCompleted = allBookings.filter(b =>
    b.booking_date === today && (b.status === "checked_out" || b.status === "cancelled" || b.status === "no_show")
  );
  const futureBookings = allBookings.filter(b => b.booking_date > today);

  const handleStatusAction = async (bookingId: string, action: string) => {
    const body: Record<string, string> = {};
    if (action === "check_in") body.status = "checked_in";
    if (action === "check_out") body.status = "checked_out";
    if (action === "cancel") body.status = "cancelled";
    if (action === "no_show") body.status = "no_show";

    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      toast.success(
        action === "check_in" ? "Checked in" :
        action === "check_out" ? "Checked out" :
        action === "no_show" ? "Marked as no-show" :
        "Booking cancelled"
      );
      fetchDashboardBookings();
      if (showAllBookings) fetchAllBookings();

      // On checkout, send cleaning alert
      if (action === "check_out") {
        fetch(`/api/bookings/${bookingId}/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "cleaning" }),
        }).catch(() => {});
      }
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Action failed");
    }
  };

  const handleResendEmail = async (bookingId: string) => {
    const res = await fetch(`/api/bookings/${bookingId}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "confirmation" }),
    });
    if (res.ok) {
      toast.success("Confirmation email sent");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to send email");
    }
  };

  const handleBulkComplete = () => {
    setSelectedIds(new Set());
    fetchDashboardBookings();
    if (showAllBookings) fetchAllBookings();
  };

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Bookings" }} />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Bookings</h1>
          <p className="text-sm text-muted-foreground">
            {todayUpcoming.length} active today &middot; {futureBookings.length} upcoming
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={locationFilter} onValueChange={(val) => setLocationFilter(val === "all" ? "" : val)}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Locations" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Locations</SelectItem>
              {locations.map(loc => <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Link href="/bookings/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Booking
            </Button>
          </Link>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex items-center gap-1 border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "list"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("list")}
        >
          <List className="inline h-4 w-4 mr-1.5 -mt-0.5" />
          List View
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "calendar"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("calendar")}
        >
          <Calendar className="inline h-4 w-4 mr-1.5 -mt-0.5" />
          Calendar
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "analytics"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("analytics")}
        >
          <BarChart3 className="inline h-4 w-4 mr-1.5 -mt-0.5" />
          Analytics
        </button>
      </div>

      {/* Calendar Tab */}
      {activeTab === "calendar" && (
        <CalendarView
          locations={locations.map(l => ({ id: l.id, name: l.name }))}
          onBookingClick={(id) => router.push(`/bookings/${id}`)}
          onSlotClick={(spaceId, date, time) =>
            router.push(`/bookings/new?space_id=${spaceId}&date=${date}&time=${time}`)
          }
        />
      )}

      {/* Analytics Tab */}
      {activeTab === "analytics" && (
        <div className="space-y-8">
          <div>
            <h2 className="text-lg font-semibold mb-4">Room Utilization</h2>
            <UtilizationDashboard locationId={locationFilter || undefined} />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-4">Revenue Reports</h2>
            <RevenueReport locationId={locationFilter || undefined} />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-4">Customer Segments</h2>
            <CustomerSegments locationId={locationFilter || undefined} />
          </div>
        </div>
      )}

      {/* List Tab */}
      {activeTab === "list" && (
        <>
          {/* Countdown timer for next booking */}
          {todayUpcoming.length > 0 && todayUpcoming[0] && (
            <BookingCountdown
              bookingDate={todayUpcoming[0].booking_date}
              startTime={todayUpcoming[0].start_time}
            />
          )}

          {loading ? <TableSkeleton rows={4} /> : (
            <div className="space-y-6">
              {/* Today — Upcoming / Active */}
              <BookingTable
                bookings={todayUpcoming}
                title="Today — Upcoming & Active"
                icon={<CalendarClock className="h-4 w-4 text-blue-600" />}
                search={todayUpcomingSearch}
                setSearch={setTodayUpcomingSearch}
                searchPlaceholder="Search by phone or name..."
                onStatusAction={handleStatusAction}
                onResendEmail={handleResendEmail}
                router={router}
                emptyMessage="No upcoming bookings for today."
                blinkUncheckedIn
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSelectAll={selectAll}
              />

              {/* Today — Completed */}
              <BookingTable
                bookings={todayCompleted}
                title="Today — Completed / Closed"
                icon={<CalendarClock className="h-4 w-4 text-gray-500" />}
                search={todayCompletedSearch}
                setSearch={setTodayCompletedSearch}
                searchPlaceholder="Search by phone or name..."
                onStatusAction={handleStatusAction}
                onResendEmail={handleResendEmail}
                router={router}
                emptyMessage="No completed bookings today."
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSelectAll={selectAll}
              />

              {/* Future Bookings */}
              <BookingTable
                bookings={futureBookings}
                title="Future Bookings"
                icon={<CalendarClock className="h-4 w-4 text-emerald-600" />}
                search={futureSearch}
                setSearch={setFutureSearch}
                searchPlaceholder="Search by phone or name..."
                onStatusAction={handleStatusAction}
                onResendEmail={handleResendEmail}
                router={router}
                emptyMessage="No future bookings."
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSelectAll={selectAll}
              />
            </div>
          )}

          {/* Toggle for all bookings history */}
          <div className="border-t pt-4">
            <Button
              variant="outline"
              onClick={() => setShowAllBookings(!showAllBookings)}
              className="w-full"
            >
              {showAllBookings ? "Hide" : "Show"} All Bookings (History)
            </Button>
          </div>

          {/* All Bookings (with full filters + pagination) */}
          {showAllBookings && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">All Bookings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Filters */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by phone, name, or booking #..."
                      value={allSearch}
                      onChange={(e) => { setAllSearch(e.target.value); setPage(1); }}
                      className="pl-9 w-[220px]"
                    />
                  </div>
                  <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}>
                    <SelectTrigger className="w-[150px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      {BOOKING_STATUSES.map(s => <SelectItem key={s} value={s}>{BOOKING_STATUS_LABELS[s]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={customerTypeFilter} onValueChange={(val) => { setCustomerTypeFilter(val === "all" ? "" : val); setPage(1); }}>
                    <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Types" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      {BOOKING_CUSTOMER_TYPES.map(t => <SelectItem key={t} value={t}>{BOOKING_CUSTOMER_TYPE_LABELS[t]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="w-[150px]" />
                  <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="w-[150px]" />
                  {(allSearch || statusFilter || customerTypeFilter || dateFrom || dateTo) && (
                    <Button variant="ghost" size="sm" onClick={() => { setAllSearch(""); setStatusFilter(""); setCustomerTypeFilter(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
                      <X className="mr-1 h-4 w-4" />Clear
                    </Button>
                  )}
                </div>

                {/* Table */}
                {allLoading ? <TableSkeleton rows={6} /> : allBookingsList.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No bookings found.</div>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="border-b bg-muted/50">
                        <th className="px-4 py-3 text-left font-medium">Booking #</th>
                        <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Space</th>
                        <th className="px-4 py-3 text-left font-medium hidden xl:table-cell">Location</th>
                        <th className="px-4 py-3 text-left font-medium">Date & Time</th>
                        <th className="px-4 py-3 text-left font-medium">Customer</th>
                        <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Phone</th>
                        <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Type</th>
                        <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Amount</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                        <th className="px-4 py-3 text-right font-medium">Actions</th>
                      </tr></thead>
                      <tbody>{allBookingsList.map((b) => {
                        const customerName = b.lead
                          ? `${b.lead.first_name} ${b.lead.last_name}`
                          : b.guest_name || "Guest";
                        const customerPhone = b.booker_phone || b.guest_phone || b.lead?.phone || "";
                        return (
                          <tr
                            key={b.id}
                            className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                            onClick={() => {
                              pushTrailEntry({ href: `/bookings/${b.id}`, label: b.booking_number });
                              router.push(`/bookings/${b.id}`);
                            }}
                          >
                            <td className="px-4 py-3 font-mono text-xs">{b.booking_number}</td>
                            <td className="px-4 py-3 hidden md:table-cell text-xs">{b.space?.name || "—"}</td>
                            <td className="px-4 py-3 hidden xl:table-cell text-xs text-muted-foreground">{b.location?.name || "—"}</td>
                            <td className="px-4 py-3">
                              <div className="text-xs">{formatDate(b.booking_date)}</div>
                              <div className="text-xs text-muted-foreground">
                                {formatTime12(b.start_time)} – {formatTime12(b.end_time)}
                              </div>
                              {b.check_in_at && (
                                <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5 flex items-center gap-1">
                                  <LogIn className="h-3 w-3 shrink-0" />
                                  {formatActualTime12(b.check_in_at)}
                                  {b.check_out_at ? (
                                    <>
                                      <LogOut className="h-3 w-3 shrink-0 ml-0.5" />
                                      {formatActualTime12(b.check_out_at)}
                                      <span className="text-muted-foreground">({actualUsageDuration(b.check_in_at, b.check_out_at)})</span>
                                    </>
                                  ) : (
                                    <span className="text-muted-foreground">(in progress)</span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs">{customerName}</td>
                            <td className="px-4 py-3 hidden lg:table-cell">
                              {customerPhone && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{customerPhone}</span>}
                            </td>
                            <td className="px-4 py-3 hidden md:table-cell">
                              <Badge variant="outline" className={`text-[10px] ${BOOKING_CUSTOMER_TYPE_COLORS[b.customer_type]}`}>
                                {BOOKING_CUSTOMER_TYPE_LABELS[b.customer_type]}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-right font-medium hidden sm:table-cell text-xs">{formatCurrency(b.total_amount_with_gst || b.total_amount + (b.gst_amount || 0))}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <Badge variant="secondary" className={`text-[10px] ${BOOKING_STATUS_COLORS[b.status]}`}>
                                  {BOOKING_STATUS_LABELS[b.status]}
                                </Badge>
                                {b.status === "checked_out" && (
                                  Array.isArray(b.feedback) && b.feedback.length > 0
                                    ? <span title="Feedback submitted"><Star className="h-3 w-3 fill-green-500 text-green-500" /></span>
                                    : <span title="Feedback pending"><MessageSquareWarning className="h-3 w-3 text-amber-500" /></span>
                                )}
                                {b.facility_resolution === "unresolved" && (
                                  <span title="Multiple facility quotas on this contract, none matched the room booked — needs manual review to attribute the right quota">
                                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                                  </span>
                                )}
                                {b.facility_resolution === "override" && (
                                  <span title={`Substitute allocation${b.facility_override_reason ? `: ${b.facility_override_reason}` : ""}`}>
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-purple-50 text-purple-700 border-purple-200">Substitute</Badge>
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0"><MoreHorizontal className="h-4 w-4" /></Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {b.status === "confirmed" && (
                                    <>
                                      <DropdownMenuItem onClick={() => handleStatusAction(b.id, "check_in")}>
                                        <LogIn className="mr-2 h-4 w-4" />Check In
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => handleStatusAction(b.id, "no_show")}>
                                        <AlertTriangle className="mr-2 h-4 w-4" />No Show
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => handleStatusAction(b.id, "cancel")} className="text-destructive">
                                        <XCircle className="mr-2 h-4 w-4" />Cancel
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => handleResendEmail(b.id)}>
                                        <Mail className="mr-2 h-4 w-4" />Resend Email
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                  {b.status === "checked_in" && (
                                    <DropdownMenuItem onClick={() => handleStatusAction(b.id, "check_out")}>
                                      <LogOut className="mr-2 h-4 w-4" />Check Out
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => copyBookingDetails(b)}>
                                    <Share2 className="mr-2 h-4 w-4" />Copy Booking Details
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {allPagination.totalPages > 1 && (
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">Page {allPagination.page} of {allPagination.totalPages} ({allPagination.total} total)</p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                      <Button variant="outline" size="sm" disabled={page >= allPagination.totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
            <BulkActionsBar
              selectedIds={Array.from(selectedIds)}
              onActionComplete={handleBulkComplete}
              onClear={() => setSelectedIds(new Set())}
            />
          )}
        </>
      )}
    </div>
  );
}
