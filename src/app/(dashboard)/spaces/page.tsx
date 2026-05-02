"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, DoorOpen, Search, X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { SpaceFormDialog } from "@/components/spaces/space-form-dialog";
import { useLocations } from "@/hooks/use-locations";
import { formatCurrency } from "@/lib/utils";
import type { Space } from "@/types";

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function SpacesPage() {
  const router = useRouter();
  const { locations } = useLocations();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [locationFilter, setLocationFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSpace, setEditSpace] = useState<Space | null>(null);

  const fetchSpaces = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (locationFilter) params.set("location_id", locationFilter);
    if (activeFilter) params.set("is_active", activeFilter);
    if (search.trim()) params.set("search", search.trim());
    try {
      const res = await fetch(`/api/spaces?${params}`);
      if (res.ok) {
        const json = await res.json();
        setSpaces(json.data || []);
        setPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [page, locationFilter, activeFilter, search]);

  useEffect(() => { fetchSpaces(); }, [fetchSpaces]);

  const clearFilters = () => {
    setSearch("");
    setLocationFilter("");
    setActiveFilter("");
    setPage(1);
  };

  const hasFilters = search || locationFilter || activeFilter;

  const handleAdd = () => {
    setEditSpace(null);
    setDialogOpen(true);
  };

  const handleEdit = (space: Space, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditSpace(space);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Spaces</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} meeting & conference rooms</p>
        </div>
        <Button onClick={handleAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add Space
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search spaces..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 w-[200px]"
          />
        </div>
        <Select value={locationFilter} onValueChange={(val) => { setLocationFilter(val === "all" ? "" : val); setPage(1); }}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="All Locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Locations</SelectItem>
            {locations.map((loc) => <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={activeFilter} onValueChange={(val) => { setActiveFilter(val === "all" ? "" : val); setPage(1); }}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="All Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="true">Active</SelectItem>
            <SelectItem value="false">Inactive</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      {loading ? <TableSkeleton rows={6} /> : spaces.length === 0 ? (
        <EmptyState
          icon={DoorOpen}
          title="No spaces found"
          description={hasFilters ? "Try adjusting your filters." : "Add your first meeting room to get started."}
          actionLabel={!hasFilters ? "Add Space" : undefined}
          onAction={!hasFilters ? handleAdd : undefined}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Location</th>
              <th className="px-4 py-3 text-right font-medium">Capacity</th>
              <th className="px-4 py-3 text-right font-medium">Rate/hr</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Facilities</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr></thead>
            <tbody>{spaces.map((space) => (
              <tr
                key={space.id}
                className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => router.push(`/spaces/${space.id}`)}
              >
                <td className="px-4 py-3 font-medium">{space.name}</td>
                <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">{space.location?.name || "—"}</td>
                <td className="px-4 py-3 text-right">{space.capacity}</td>
                <td className="px-4 py-3 text-right font-medium">
                  {space.pricing_model === "daily" ? (
                    <>
                      {formatCurrency(Number(space.daily_rate ?? 0))}
                      <span className="text-[10px] text-muted-foreground ml-1">/day</span>
                    </>
                  ) : (
                    <>
                      {formatCurrency(space.hourly_rate)}
                      <span className="text-[10px] text-muted-foreground ml-1">/hr</span>
                    </>
                  )}
                </td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  {space.facilities && space.facilities.length > 0 ? (
                    <span className="text-muted-foreground text-xs">
                      {space.facilities.slice(0, 3).map(f => f.name).join(", ")}
                      {space.facilities.length > 3 && ` +${space.facilities.length - 3}`}
                    </span>
                  ) : "—"}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={space.is_active ? "default" : "secondary"}>
                    {space.is_active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={(e) => handleEdit(space, e)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}</tbody>
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

      <SpaceFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        space={editSpace}
        onSuccess={fetchSpaces}
      />
    </div>
  );
}
