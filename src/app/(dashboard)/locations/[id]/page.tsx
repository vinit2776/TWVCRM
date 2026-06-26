"use client";

import { use, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  LayoutGrid,
  BarChart3,
  Info,
  MapPin,
  Layers,
  Zap,
  ConciergeBell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { FloorFormDialog } from "@/components/spaces/floor-form-dialog";
import { SpaceUnitFormDialog } from "@/components/spaces/space-unit-form-dialog";
import { SpaceAnalyticsPanel } from "@/components/spaces/space-analytics";
import { LocationFormDialog } from "@/components/locations/location-form-dialog";
import { ElectricityConfigTab } from "@/components/locations/electricity-config-tab";
import { LocationServicesTab } from "@/components/locations/location-services-tab";
import { useCurrentUser } from "@/providers/current-user-provider";
import type { Location, LocationFloor, SpaceUnit, SpaceAnalytics } from "@/types";

type Tab = "overview" | "spaces" | "analytics" | "electricity" | "services";

export default function LocationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [tab, setTab] = useState<Tab>("spaces");
  const [location, setLocation] = useState<Location | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);

  // Floors & units
  const [floors, setFloors] = useState<LocationFloor[]>([]);
  const [floorsLoading, setFloorsLoading] = useState(false);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [units, setUnits] = useState<SpaceUnit[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(false);

  // Dialogs
  const [editLocationOpen, setEditLocationOpen] = useState(false);
  const [floorDialogOpen, setFloorDialogOpen] = useState(false);
  const [editFloor, setEditFloor] = useState<LocationFloor | null>(null);
  const [unitDialogOpen, setUnitDialogOpen] = useState(false);
  const [editUnit, setEditUnit] = useState<SpaceUnit | null>(null);

  // Analytics
  const [analytics, setAnalytics] = useState<SpaceAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // Electricity config access
  const { user } = useCurrentUser();
  const canEditElectricity = user?.role === "admin" || user?.role === "manager";

  // ── Fetchers ─────────────────────────────────────────────────────────────
  const fetchLocation = useCallback(async () => {
    setLocationLoading(true);
    const res = await fetch(`/api/locations/${id}`);
    if (res.ok) {
      const json = await res.json();
      setLocation(json.data || null);
    }
    setLocationLoading(false);
  }, [id]);

  const fetchFloors = useCallback(async () => {
    setFloorsLoading(true);
    const res = await fetch(`/api/locations/${id}/floors`);
    if (res.ok) {
      const json = await res.json();
      const data: LocationFloor[] = json.data || [];
      setFloors(data);
      if (data.length > 0 && !selectedFloorId) {
        setSelectedFloorId(data[0].id);
      }
    }
    setFloorsLoading(false);
  }, [id, selectedFloorId]);

  const fetchUnits = useCallback(async (floorId: string) => {
    setUnitsLoading(true);
    const res = await fetch(`/api/locations/${id}/space-units?floor_id=${floorId}&is_active=true`);
    if (res.ok) {
      const json = await res.json();
      setUnits(json.data || []);
    }
    setUnitsLoading(false);
  }, [id]);

  const fetchAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    const res = await fetch(`/api/locations/${id}/space-analytics`);
    if (res.ok) {
      const json = await res.json();
      setAnalytics(json.data || null);
    }
    setAnalyticsLoading(false);
  }, [id]);

  useEffect(() => { fetchLocation(); }, [fetchLocation]);
  useEffect(() => { fetchFloors(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedFloorId) fetchUnits(selectedFloorId);
  }, [selectedFloorId, fetchUnits]);
  useEffect(() => {
    if (tab === "analytics") fetchAnalytics();
  }, [tab, fetchAnalytics]);

  // ── Selected floor object ─────────────────────────────────────────────────
  const selectedFloor = floors.find((f) => f.id === selectedFloorId) ?? null;

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleFloorAdded = (floor: LocationFloor) => {
    setFloors((prev) => {
      const updated = prev.find((f) => f.id === floor.id)
        ? prev.map((f) => f.id === floor.id ? floor : f)
        : [...prev, floor];
      return updated.sort((a, b) => a.sort_order - b.sort_order || (a.floor_number ?? 0) - (b.floor_number ?? 0));
    });
    setSelectedFloorId(floor.id);
  };

  const handleFloorDelete = async (floor: LocationFloor) => {
    if (!window.confirm(`Delete floor "${floor.name}"? All space units on this floor will also be removed.`)) return;
    const res = await fetch(`/api/locations/${id}/floors/${floor.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Floor deleted");
      setFloors((prev) => prev.filter((f) => f.id !== floor.id));
      setSelectedFloorId((prev) => prev === floor.id ? (floors.find((f) => f.id !== floor.id)?.id ?? null) : prev);
      if (selectedFloorId === floor.id) setUnits([]);
    } else {
      const json = await res.json().catch(() => null);
      toast.error(json?.error || "Failed to delete floor");
    }
  };

  const handleUnitSaved = (unit: SpaceUnit) => {
    setUnits((prev) => {
      const exists = prev.find((u) => u.id === unit.id);
      return exists ? prev.map((u) => u.id === unit.id ? unit : u) : [...prev, unit];
    });
  };

  const handleUnitClick = (unit: SpaceUnit) => {
    setEditUnit(unit);
    setUnitDialogOpen(true);
  };

  const handleUnitDelete = async (unit: SpaceUnit) => {
    if (!window.confirm(`Remove "${unit.name}" from inventory?`)) return;
    const res = await fetch(`/api/locations/${id}/space-units/${unit.id}`, { method: "DELETE" });
    if (res.ok) {
      setUnits((prev) => prev.filter((u) => u.id !== unit.id));
      toast.success("Unit removed");
    } else {
      const json = await res.json().catch(() => null);
      toast.error(json?.error || "Failed to remove unit");
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (locationLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (!location) {
    return (
      <div className="text-center py-16">
        <MapPin className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">Location not found</p>
        <Link href="/locations">
          <Button variant="link" className="mt-2">Back to Locations</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/locations">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{location.name}</h1>
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{location.code}</code>
              <Badge variant={location.is_active ? "default" : "secondary"}>
                {location.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
            {location.city && (
              <p className="text-sm text-muted-foreground">{location.city}{location.state ? `, ${location.state}` : ""}</p>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditLocationOpen(true)}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit Location
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b gap-1 flex-wrap">
        {(["overview", "spaces", "analytics", "electricity", "services"] as Tab[]).map((t) => {
          if (t === "electricity" && !canEditElectricity) return null;
          if (t === "services" && !canEditElectricity) return null;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize -mb-px ${
                tab === t
                  ? "border-[#015E65] text-[#015E65]"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "overview" && <Info className="inline mr-1.5 h-3.5 w-3.5" />}
              {t === "spaces" && <LayoutGrid className="inline mr-1.5 h-3.5 w-3.5" />}
              {t === "analytics" && <BarChart3 className="inline mr-1.5 h-3.5 w-3.5" />}
              {t === "electricity" && <Zap className="inline mr-1.5 h-3.5 w-3.5" />}
              {t === "services" && <ConciergeBell className="inline mr-1.5 h-3.5 w-3.5" />}
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          );
        })}
      </div>

      {/* ── OVERVIEW TAB ─────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Location Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Name</span>
                <span className="font-medium">{location.name}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Code</span>
                <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{location.code}</code>
              </div>
              {location.address && (
                <>
                  <Separator />
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground shrink-0">Address</span>
                    <span className="text-right">{location.address}</span>
                  </div>
                </>
              )}
              {location.city && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">City</span>
                    <span>{location.city}</span>
                  </div>
                </>
              )}
              {location.state && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">State</span>
                    <span>{location.state}</span>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={location.is_active ? "default" : "secondary"}>
                  {location.is_active ? "Active" : "Inactive"}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Space Inventory Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {floors.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-muted-foreground text-sm">No floors configured yet.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => { setTab("spaces"); setFloorDialogOpen(true); }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add First Floor
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Total Floors</span>
                    <span className="font-medium text-foreground">{floors.length}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between text-muted-foreground">
                    <span>Total Units</span>
                    <span className="font-medium text-foreground">{units.length + (selectedFloorId ? 0 : 0)}</span>
                  </div>
                  <div className="mt-4">
                    <Button variant="outline" size="sm" onClick={() => setTab("spaces")}>
                      <LayoutGrid className="mr-2 h-4 w-4" />
                      View Floor Plan
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── SPACES TAB ───────────────────────────────────────────────────── */}
      {tab === "spaces" && (
        <div className="space-y-4">
          {/* Floor pill bar */}
          <div className="flex flex-wrap items-center gap-2">
            {floorsLoading ? (
              <div className="h-8 w-48 bg-muted animate-pulse rounded-full" />
            ) : floors.length === 0 ? null : (
              floors.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSelectedFloorId(f.id)}
                  className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
                    selectedFloorId === f.id
                      ? "bg-[#015E65] text-white border-[#015E65]"
                      : "bg-background border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f.name}
                </button>
              ))
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => { setEditFloor(null); setFloorDialogOpen(true); }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add Floor
            </Button>
          </div>

          {/* No floors empty state */}
          {!floorsLoading && floors.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <LayoutGrid className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="font-medium mb-1">No floors configured</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Add a floor to start laying out your space inventory on the canvas.
                </p>
                <Button onClick={() => { setEditFloor(null); setFloorDialogOpen(true); }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add First Floor
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Floor units area */}
          {selectedFloor && (
            <div className="space-y-3">
              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{selectedFloor.name}</h3>
                  {selectedFloor.total_area_sqft > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {selectedFloor.leasable_area_sqft.toLocaleString()} / {selectedFloor.total_area_sqft.toLocaleString()} sqft leasable
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setEditUnit(null); setUnitDialogOpen(true); }}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add Unit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setEditFloor(selectedFloor); setFloorDialogOpen(true); }}
                  >
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    Edit Floor
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleFloorDelete(selectedFloor)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Unit list */}
              {unitsLoading ? (
                <div className="h-32 bg-muted animate-pulse rounded-lg" />
              ) : units.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="px-4 py-2.5 text-left font-medium">Code</th>
                        <th className="px-4 py-2.5 text-left font-medium">Name</th>
                        <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Type</th>
                        <th className="px-4 py-2.5 text-right font-medium hidden sm:table-cell">Seats</th>
                        <th className="px-4 py-2.5 text-right font-medium">Rate</th>
                        <th className="px-4 py-2.5 text-center font-medium">Status</th>
                        <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {units.map((u) => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const isContracted = (u as any).active_allocations?.length > 0;
                        return (
                          <tr key={u.id} className="border-b hover:bg-muted/20 transition-colors">
                            <td className="px-4 py-2.5">
                              <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{u.code}</code>
                            </td>
                            <td className="px-4 py-2.5 font-medium">{u.name}</td>
                            <td className="px-4 py-2.5 hidden sm:table-cell text-muted-foreground capitalize">
                              {u.type.replace(/_/g, " ")}
                            </td>
                            <td className="px-4 py-2.5 text-right hidden sm:table-cell">{u.capacity}</td>
                            <td className="px-4 py-2.5 text-right font-medium">
                              {u.type === "business_centre" ? (
                                <>₹{(u.hourly_rate ?? 0).toLocaleString("en-IN")}<span className="text-xs text-muted-foreground font-normal"> /hr</span></>
                              ) : (
                                <>₹{(u.monthly_rate ?? 0).toLocaleString("en-IN")}<span className="text-xs text-muted-foreground font-normal"> /mo</span></>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <Badge
                                variant={isContracted ? "default" : "secondary"}
                                className={isContracted ? "bg-green-100 text-green-700 border-green-200" : ""}
                              >
                                {isContracted ? "Contracted" : "Vacant"}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => handleUnitClick(u)}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => handleUnitDelete(u)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 border rounded-lg border-dashed">
                  <p className="text-muted-foreground text-sm">No units on this floor yet.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => { setEditUnit(null); setUnitDialogOpen(true); }}
                  >
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    Add First Unit
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ANALYTICS TAB ────────────────────────────────────────────────── */}
      {tab === "analytics" && (
        <div>
          {analyticsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-32 bg-muted animate-pulse rounded-lg" />
              ))}
            </div>
          ) : !analytics ? (
            <Card>
              <CardContent className="py-12 text-center">
                <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="font-medium mb-1">No analytics data yet</p>
                <p className="text-sm text-muted-foreground">
                  Add floors and space units to see CUF, occupancy, and revenue analytics.
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => setTab("spaces")}>
                  <LayoutGrid className="mr-2 h-4 w-4" />
                  Set Up Spaces
                </Button>
              </CardContent>
            </Card>
          ) : (
            <SpaceAnalyticsPanel analytics={analytics} />
          )}
        </div>
      )}

      {/* ── ELECTRICITY TAB ──────────────────────────────────────────────── */}
      {tab === "electricity" && (
        <ElectricityConfigTab locationId={id} canEdit={canEditElectricity} />
      )}

      {/* ── SERVICES TAB ─────────────────────────────────────────────────── */}
      {tab === "services" && (
        <LocationServicesTab
          locationId={id}
          canEdit={canEditElectricity}
          initialAmenityIcons={location.proposal_amenity_icons}
        />
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      <LocationFormDialog
        open={editLocationOpen}
        onOpenChange={setEditLocationOpen}
        location={location}
        onSuccess={fetchLocation}
      />

      <FloorFormDialog
        open={floorDialogOpen}
        onOpenChange={setFloorDialogOpen}
        locationId={id}
        floor={editFloor}
        onSuccess={handleFloorAdded}
      />

      <SpaceUnitFormDialog
        open={unitDialogOpen}
        onOpenChange={(open) => {
          setUnitDialogOpen(open);
          if (!open) setEditUnit(null);
        }}
        locationId={id}
        floor={selectedFloor ?? null}
        existingUnits={units}
        unit={editUnit}
        onSuccess={handleUnitSaved}
        onDelete={handleUnitDelete}
      />
    </div>
  );
}
