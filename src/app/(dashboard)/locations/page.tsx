"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MapPin, Plus, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocations } from "@/hooks/use-locations";
import { LocationFormDialog } from "@/components/locations/location-form-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";
import type { Location } from "@/types";

export default function LocationsPage() {
  const { locations, loading, refetch } = useLocations(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editLocation, setEditLocation] = useState<Location | null>(null);
  const router = useRouter();

  const handleEdit = (e: React.MouseEvent, loc: Location) => {
    e.stopPropagation();
    setEditLocation(loc);
    setDialogOpen(true);
  };

  const handleAdd = () => {
    setEditLocation(null);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Locations" }} />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Locations</h1>
          <p className="text-sm text-muted-foreground">Manage your coworking centers</p>
        </div>
        <Button onClick={handleAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add Location
        </Button>
      </div>

      {loading ? <TableSkeleton rows={4} /> : locations.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No locations yet"
          description="Add your first coworking center."
          actionLabel="Add Location"
          onAction={handleAdd}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Code</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">City</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Address</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Floor In-Charges</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium w-[60px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => (
                <tr
                  key={loc.id}
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => {
                    pushTrailEntry({ href: `/locations/${loc.id}`, label: loc.name });
                    router.push(`/locations/${loc.id}`);
                  }}
                >
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/locations/${loc.id}`}
                      className="hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        pushTrailEntry({ href: `/locations/${loc.id}`, label: loc.name });
                      }}
                    >
                      {loc.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{loc.code}</code>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">{loc.city || "—"}</td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground max-w-[200px] truncate">
                    {loc.address || "—"}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                    {/* Quick visual cue that the location is wired up to
                        receive routed alerts. Empty cell = a config gap. */}
                    {loc.incharge_1 || loc.incharge_2 ? (
                      <div className="flex flex-col gap-0.5">
                        {loc.incharge_1 && <span>{loc.incharge_1.full_name}</span>}
                        {loc.incharge_2 && <span>{loc.incharge_2.full_name}</span>}
                      </div>
                    ) : (
                      <span className="text-amber-600">— Not assigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={loc.is_active ? "default" : "secondary"}>
                      {loc.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => handleEdit(e, loc)}
                      title="Edit location"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LocationFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        location={editLocation}
        onSuccess={refetch}
      />
    </div>
  );
}
