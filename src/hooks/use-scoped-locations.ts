"use client";

import { useState, useEffect, useMemo } from "react";

/**
 * useScopedLocations — resolves which locations the current user should see.
 *
 * HO roles (admin / manager / office_admin) are "cross-location" and see every
 * active location. Everyone else is scoped to the locations they're assigned to
 * in user_locations (primary first). Single source of truth for location
 * scoping across Inventory, Transfers and Consumption.
 */

export interface ScopedLocation {
  id: string;
  name: string;
  code?: string | null;
}

interface Assignment {
  location_id: string;
  responsibility: "primary" | "secondary";
  location: ScopedLocation | null;
}

const CROSS_LOCATION_ROLES = ["admin", "manager", "office_admin"];

export function useScopedLocations() {
  const [allLocations, setAllLocations] = useState<ScopedLocation[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [role, setRole] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      fetch("/api/locations").then((r) => r.json()).catch(() => ({ data: [] })),
      fetch("/api/me/locations").then((r) => r.json()).catch(() => ({ data: [], role: "" })),
    ])
      .then(([locRes, mineRes]) => {
        if (!active) return;
        const all = (locRes.data || locRes.locations || []).filter(
          (l: ScopedLocation & { is_active?: boolean }) => l.is_active !== false
        );
        setAllLocations(Array.isArray(all) ? all : []);
        setAssignments(Array.isArray(mineRes.data) ? mineRes.data : []);
        setRole(mineRes.role || "");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const isCrossLocationRole = CROSS_LOCATION_ROLES.includes(role);

  // A user is actually scoped only if they're a non-HO role AND have at least
  // one assignment. A non-HO user with NO assignments falls back to seeing all
  // locations (today's behaviour) so nobody is locked out before admins have
  // populated user_locations.
  const isScoped = !isCrossLocationRole && assignments.length > 0;

  const availableLocations = useMemo<ScopedLocation[]>(() => {
    if (!isScoped) return allLocations;
    return assignments
      .slice()
      .sort((a) => (a.responsibility === "primary" ? -1 : 1))
      .map((a) => a.location)
      .filter((l): l is ScopedLocation => !!l);
  }, [isScoped, allLocations, assignments]);

  const assignedLocationIds = useMemo(
    () => assignments.map((a) => a.location_id),
    [assignments]
  );

  const primaryLocationId = useMemo(() => {
    if (!isScoped) return availableLocations[0]?.id ?? "";
    const primary = assignments.find((a) => a.responsibility === "primary");
    return primary?.location_id ?? availableLocations[0]?.id ?? "";
  }, [isScoped, assignments, availableLocations]);

  return {
    loading,
    role,
    isCrossLocationRole,
    isScoped,
    availableLocations,
    assignedLocationIds,
    primaryLocationId,
  };
}
