"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  ShieldCheck,
  User,
  Users,
  Plus,
  KeyRound,
  UserCog,
  Ban,
  CheckCircle,
  Loader2,
  MoreHorizontal,
  Eye,
  EyeOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { getInitials, formatDate } from "@/lib/utils";
import type { User as UserType } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> =
  {
    admin: ShieldCheck,
    manager: Shield,
    sales_rep: User,
  };

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-red-100 text-red-800",
  manager: "bg-blue-100 text-blue-800",
  sales_rep: "bg-gray-100 text-gray-800",
};

export default function TeamPage() {
  const [users, setUsers] = useState<UserType[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  // Create user dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    full_name: "",
    email: "",
    password: "",
    role: "sales_rep",
    phone: "",
  });
  const [creating, setCreating] = useState(false);
  const [showCreatePassword, setShowCreatePassword] = useState(false);

  // Change password dialog state
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<UserType | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  // Edit user dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserType | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: "",
    phone: "",
    role: "sales_rep",
  });
  const [editing, setEditing] = useState(false);

  // Action menu state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/users");
    if (res.ok) {
      const json = await res.json();
      setUsers(json.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUsers();
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        const { data } = await supabase
          .from("users")
          .select("role")
          .eq("auth_id", user.id)
          .single();
        setCurrentUserRole(data?.role || null);
      }
    });
  }, [fetchUsers]);

  // Close menu on outside click
  useEffect(() => {
    const handleClick = () => setOpenMenuId(null);
    if (openMenuId) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [openMenuId]);

  const isAdmin = currentUserRole === "admin";

  // --- Create user ---
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.email || !createForm.full_name || !createForm.password) {
      toast.error("Please fill all required fields");
      return;
    }
    if (createForm.password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setCreating(true);
    const res = await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });

    setCreating(false);
    if (res.ok) {
      toast.success("Team member created successfully");
      setCreateOpen(false);
      setCreateForm({
        full_name: "",
        email: "",
        password: "",
        role: "sales_rep",
        phone: "",
      });
      setShowCreatePassword(false);
      fetchUsers();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create user");
    }
  };

  // --- Role change ---
  const handleRoleChange = async (userId: string, newRole: string) => {
    const res = await fetch(`/api/team/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      toast.success("Role updated successfully");
      fetchUsers();
    } else {
      toast.error("Failed to update role");
    }
  };

  // --- Toggle active ---
  const handleToggleActive = async (userId: string, isActive: boolean) => {
    const res = await fetch(`/api/team/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !isActive }),
    });
    if (res.ok) {
      toast.success(isActive ? "User suspended" : "User activated");
      fetchUsers();
    } else {
      toast.error("Failed to update user status");
    }
  };

  // --- Change password ---
  const openPasswordDialog = (member: UserType) => {
    setPasswordTarget(member);
    setNewPassword("");
    setShowNewPassword(false);
    setPasswordOpen(true);
    setOpenMenuId(null);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordTarget || !newPassword) return;
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setChangingPassword(true);
    const res = await fetch(`/api/team/${passwordTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });

    setChangingPassword(false);
    if (res.ok) {
      toast.success("Password changed successfully");
      setPasswordOpen(false);
      setPasswordTarget(null);
      setNewPassword("");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to change password");
    }
  };

  // --- Edit user ---
  const openEditDialog = (member: UserType) => {
    setEditTarget(member);
    setEditForm({
      full_name: member.full_name,
      phone: member.phone || "",
      role: member.role,
    });
    setEditOpen(true);
    setOpenMenuId(null);
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    if (!editForm.full_name.trim()) {
      toast.error("Name is required");
      return;
    }

    setEditing(true);
    const res = await fetch(`/api/team/${editTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm),
    });

    setEditing(false);
    if (res.ok) {
      toast.success("User updated successfully");
      setEditOpen(false);
      setEditTarget(null);
      fetchUsers();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update user");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Team Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage team members and their roles
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Team Member
          </Button>
        )}
      </div>

      {/* RBAC Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Role Permissions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-red-600" />
                <span className="font-medium text-sm">Admin</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Full access + delete records + manage team roles
              </p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-blue-600" />
                <span className="font-medium text-sm">Manager</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Full access to all leads, tasks, and records
              </p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-gray-600" />
                <span className="font-medium text-sm">Sales Rep</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Own leads + assigned tasks only
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Team Members */}
      {loading ? (
        <TableSkeleton rows={4} />
      ) : users.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No team members"
          description="Add team members to get started."
          actionLabel={isAdmin ? "Add Team Member" : undefined}
          onAction={isAdmin ? () => setCreateOpen(true) : undefined}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Member</th>
                <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">
                  Email
                </th>
                <th className="px-4 py-3 text-left font-medium">Role</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                  Joined
                </th>
                {isAdmin && (
                  <th className="px-4 py-3 text-left font-medium w-20">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {users.map((member) => {
                const RoleIcon = ROLE_ICONS[member.role] || User;
                return (
                  <tr
                    key={member.id}
                    className="border-b hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs">
                            {getInitials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <span className="font-medium">
                            {member.full_name}
                          </span>
                          <p className="text-xs text-muted-foreground sm:hidden">
                            {member.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                      {member.email}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="secondary"
                        className={ROLE_COLORS[member.role]}
                      >
                        <RoleIcon className="h-3 w-3 mr-1" />
                        {USER_ROLE_LABELS[member.role]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <Badge
                        variant={member.is_active ? "default" : "secondary"}
                      >
                        {member.is_active ? "Active" : "Suspended"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      {formatDate(member.created_at)}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <div className="relative">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(
                                openMenuId === member.id ? null : member.id
                              );
                            }}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                          {openMenuId === member.id && (
                            <div className="absolute right-0 top-full z-50 w-48 rounded-md border bg-popover p-1 shadow-md">
                              <button
                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                                onClick={() => openEditDialog(member)}
                              >
                                <UserCog className="h-4 w-4" />
                                Edit Details
                              </button>
                              <button
                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                                onClick={() => openPasswordDialog(member)}
                              >
                                <KeyRound className="h-4 w-4" />
                                Change Password
                              </button>
                              <div className="my-1 h-px bg-border" />
                              <button
                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                                onClick={() => {
                                  handleToggleActive(
                                    member.id,
                                    member.is_active
                                  );
                                  setOpenMenuId(null);
                                }}
                              >
                                {member.is_active ? (
                                  <>
                                    <Ban className="h-4 w-4 text-red-500" />
                                    <span className="text-red-500">
                                      Suspend User
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle className="h-4 w-4 text-green-500" />
                                    <span className="text-green-500">
                                      Activate User
                                    </span>
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create User Dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Team Member</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-name">
                Full Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="create-name"
                value={createForm.full_name}
                onChange={(e) =>
                  setCreateForm({ ...createForm, full_name: e.target.value })
                }
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-email">
                Email <span className="text-destructive">*</span>
              </Label>
              <Input
                id="create-email"
                type="email"
                value={createForm.email}
                onChange={(e) =>
                  setCreateForm({ ...createForm, email: e.target.value })
                }
                placeholder="john@theworkvilla.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-password">
                Password <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="create-password"
                  type={showCreatePassword ? "text" : "password"}
                  value={createForm.password}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, password: e.target.value })
                  }
                  placeholder="Min 6 characters"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowCreatePassword(!showCreatePassword)}
                >
                  {showCreatePassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-phone">Phone</Label>
              <Input
                id="create-phone"
                value={createForm.phone}
                onChange={(e) =>
                  setCreateForm({ ...createForm, phone: e.target.value })
                }
                placeholder="+91 98765 43210"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-role">Role</Label>
              <Select
                value={createForm.role}
                onValueChange={(val) =>
                  setCreateForm({ ...createForm, role: val })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="sales_rep">Sales Rep</SelectItem>
                  <SelectItem value="floor_manager">Floor Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Create User
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Change Password Dialog ── */}
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Change Password
              {passwordTarget && (
                <span className="block text-sm font-normal text-muted-foreground mt-1">
                  for {passwordTarget.full_name}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">
                New Password <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 6 characters"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                >
                  {showNewPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPasswordOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={changingPassword}>
                {changingPassword && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Update Password
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Edit User Dialog ── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Edit User
              {editTarget && (
                <span className="block text-sm font-normal text-muted-foreground mt-1">
                  {editTarget.email}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditUser} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">
                Full Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-name"
                value={editForm.full_name}
                onChange={(e) =>
                  setEditForm({ ...editForm, full_name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input
                id="edit-phone"
                value={editForm.phone}
                onChange={(e) =>
                  setEditForm({ ...editForm, phone: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={editForm.role}
                onValueChange={(val) =>
                  setEditForm({ ...editForm, role: val })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="sales_rep">Sales Rep</SelectItem>
                  <SelectItem value="floor_manager">Floor Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={editing}>
                {editing && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save Changes
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
