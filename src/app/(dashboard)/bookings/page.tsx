"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus, CalendarClock, Search, X, ChevronLeft, ChevronRight,
  LogIn, LogOut, XCircle, MoreHorizontal, Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { useLocations } from "@/hooks/use-locations";
import { formatDate, formatCurrency } from "@/lib/utils";
import {
  BOOKING_STATUSES, BOOKING_STATUS_LABELS, BOOKING_STATUS_COLORS,
  BOOKING_CUSTOMER_TYPES, BOOKING_CUSTOMER_TYPE_LABELS, BOOKING_CUSTOMER_TYPE_COLORS,
  BOOKING_PAYMENT_STATUS_LABELS, BOOKING_PAYMENT_STATUS_COLORS,
} from "@/lib/constants";
import { toast } from "sonner";
import type { Booking } from "@/types";

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatTime12(timeStr: string): string {
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function BookingsPage() {
  const router = useRouter();
  const { locations } = useLocations();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [locationFilter, setLocationFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [customerTypeFilter, setCustomerTypeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (locationFilter) params.set("location_id", locationFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (customerTypeFilter) params.set("customer_type", customerTypeFilter);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (search.trim()) params.set("search", search.trim());
    try {
      const res = await fetch(`/api/bookings?${params}`);
      if (res.ok) {
        const json = await res.json();
        setBookings(json.data || []);
        setPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [page, locationFilter, statusFilter, customerTypeFilter, dateFrom, dateTo, search]);

  useEffect(() => { fetchBookings(); }, [fetchBookings]);

  const clearFilters = () => {
    setSearch("");
    setLocationFilter("");
    setStatusFilter("");
    setCustomerTypeFilter("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const hasFilters = search || locationFilter || statusFilter || customerTypeFilter || dateFrom || dateTo;

  const handleStatusAction = async (bookingId: string, action: string) => {
    const body: Record<string, string> = {};
    if (action === "check_in") body.status = "checked_in";
    if (action === "check_out") body.status = "checked_out";
    if (action === "cancel") body.status = "cancelled";

    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      toast.success(
        action === "check_in" ? "Checked in" :
        action === "check_out" ? "Checked out" :
        "Booking cancelled"
      );
      fetchBookings();

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

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Bookings</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total bookings</p>
        </div>
        <Link href="/bookings/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Booking
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search bookings..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 w-[180px]"
          />
        </div>
        <Select value={locationFilter} onValueChange={(val) => { setLocationFilter(val === "all" ? "" : val); setPage(1); }}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Locations</SelectItem>
            {locations.map(loc => <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>)}
          </SelectContent>
        </Select>
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
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      {loading ? <TableSkeleton rows={6} /> : bookings.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No bookings found"
          description={hasFilters ? "Try adjusting your filters." : "Create your first booking to get started."}
          actionLabel={!hasFilters ? "New Booking" : undefined}
          onAction={!hasFilters ? () => router.push("/bookings/new") : undefined}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Booking #</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Space</th>
              <th className="px-4 py-3 text-left font-medium">Date & Time</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Customer</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Type</th>
              <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Amount</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Payment</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr></thead>
            <tbody>{bookings.map((b) => {
              const customerName = b.lead
                ? `${b.lead.first_name} ${b.lead.last_name}`
                : b.guest_name || "Guest";
              return (
                <tr
                  key={b.id}
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/bookings/${b.id}`)}
                >
                  <td className="px-4 py-3 font-mono text-xs">{b.booking_number}</td>
                  <td className="px-4 py-3 hidden md:table-cell">{b.space?.name || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="text-xs">{formatDate(b.booking_date)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatTime12(b.start_time)} – {formatTime12(b.end_time)}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">{customerName}</td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <Badge variant="outline" className={`text-[10px] ${BOOKING_CUSTOMER_TYPE_COLORS[b.customer_type]}`}>
                      {BOOKING_CUSTOMER_TYPE_LABELS[b.customer_type]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right font-medium hidden sm:table-cell">{formatCurrency(b.total_amount)}</td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <Badge variant="secondary" className={`text-[10px] ${BOOKING_PAYMENT_STATUS_COLORS[b.payment_status]}`}>
                      {BOOKING_PAYMENT_STATUS_LABELS[b.payment_status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className={BOOKING_STATUS_COLORS[b.status]}>
                      {BOOKING_STATUS_LABELS[b.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {b.status === "confirmed" && (
                          <>
                            <DropdownMenuItem onClick={() => handleStatusAction(b.id, "check_in")}>
                              <LogIn className="mr-2 h-4 w-4" />Check In
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
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
