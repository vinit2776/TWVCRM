"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Search } from "lucide-react";

interface UserLocationRow {
  id: string;
  user_id: string;
  location_id: string;
  responsibility: "primary" | "secondary";
  user: { id: string; full_name: string; email: string; role: string };
  location: { id: string; name: string };
}

interface User {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface Location {
  id: string;
  name: string;
}

export default function UserLocationsPage() {
  const [rows, setRows] = useState<UserLocationRow[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterLocation, setFilterLocation] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [addUserId, setAddUserId] = useState("");
  const [addLocationId, setAddLocationId] = useState("");
  const [addResponsibility, setAddResponsibility] = useState<"primary" | "secondary">("primary");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [ulRes, usersRes, locsRes] = await Promise.all([
        fetch("/api/admin/user-locations").then((r) => r.json()),
        fetch("/api/users").then((r) => r.json()),
        fetch("/api/locations").then((r) => r.json()),
      ]);
      setRows(ulRes.data ?? []);
      setUsers(usersRes.data ?? usersRes.users ?? []);
      setLocations(locsRes.data ?? locsRes.locations ?? []);
    } catch {
      toast.error("Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = rows.filter((r) => {
    const matchSearch =
      !search ||
      r.user.full_name.toLowerCase().includes(search.toLowerCase()) ||
      r.user.email.toLowerCase().includes(search.toLowerCase()) ||
      r.location.name.toLowerCase().includes(search.toLowerCase());
    const matchLocation = filterLocation === "all" || r.location_id === filterLocation;
    return matchSearch && matchLocation;
  });

  const handleAdd = async () => {
    if (!addUserId || !addLocationId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/user-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: addUserId,
          location_id: addLocationId,
          responsibility: addResponsibility,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to assign");
      toast.success("Assignment added");
      setShowAdd(false);
      setAddUserId("");
      setAddLocationId("");
      setAddResponsibility("primary");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/user-locations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
      toast.success("Assignment removed");
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">User-Location Assignments</h1>
          <p className="text-muted-foreground text-sm">
            Control which locations each staff member can log consumption for.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Assign User
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search users or locations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterLocation} onValueChange={setFilterLocation}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All locations" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations.map((loc) => (
              <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="border rounded-lg p-12 text-center text-muted-foreground">
          No assignments found.
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">User</th>
                <th className="text-left p-3 font-medium">Role</th>
                <th className="text-left p-3 font-medium">Location</th>
                <th className="text-left p-3 font-medium">Responsibility</th>
                <th className="p-3 w-12" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((row) => (
                <tr key={row.id} className="hover:bg-muted/20">
                  <td className="p-3">
                    <div className="font-medium">{row.user.full_name}</div>
                    <div className="text-xs text-muted-foreground">{row.user.email}</div>
                  </td>
                  <td className="p-3 text-muted-foreground capitalize">{row.user.role.replace("_", " ")}</td>
                  <td className="p-3 font-medium">{row.location.name}</td>
                  <td className="p-3">
                    <Badge variant={row.responsibility === "primary" ? "default" : "secondary"}>
                      {row.responsibility}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(row.id)}
                      disabled={deletingId === row.id}
                    >
                      {deletingId === row.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign User to Location</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>User</Label>
              <Select value={addUserId} onValueChange={setAddUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select user..." />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name}
                      <span className="ml-2 text-xs text-muted-foreground">{u.role}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={addLocationId} onValueChange={setAddLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Responsibility</Label>
              <Select
                value={addResponsibility}
                onValueChange={(v) => setAddResponsibility(v as "primary" | "secondary")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="primary">Primary</SelectItem>
                  <SelectItem value="secondary">Secondary</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={saving || !addUserId || !addLocationId}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
