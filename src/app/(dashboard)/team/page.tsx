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
  Building2,
  Receipt,
  Wrench,
  Briefcase,
  Check,
  Minus,
  BellRing,
  BellOff,
  Copy,
  CheckCheck,
  Share2,
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
import { toast } from "sonner";
import { UserActivityLogDialog } from "@/components/team/user-activity-log";

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  admin: ShieldCheck,
  manager: Shield,
  sales_rep: User,
  floor_manager: Building2,
  accounts: Receipt,
  fms: Wrench,
  office_admin: Briefcase,
  it_team: Wrench,
};

const ROLE_COLORS: Record<string, string> = {
  admin:         "bg-red-100 text-red-800",
  manager:       "bg-blue-100 text-blue-800",
  sales_rep:     "bg-gray-100 text-gray-800",
  floor_manager: "bg-green-100 text-green-800",
  accounts:      "bg-amber-100 text-amber-800",
  fms:           "bg-purple-100 text-purple-800",
  office_admin:  "bg-orange-100 text-orange-800",
  it_team:       "bg-cyan-100 text-cyan-800",
};

const ROLE_ICON_COLORS: Record<string, string> = {
  admin:         "text-red-600",
  manager:       "text-blue-600",
  sales_rep:     "text-gray-600",
  floor_manager: "text-green-600",
  accounts:      "text-amber-600",
  fms:           "text-purple-600",
  office_admin:  "text-orange-600",
  it_team:       "text-cyan-600",
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin:         "Full system access including team management, settings, and all modules",
  manager:       "Broad operational access across leads, bookings, billing, and procurement",
  sales_rep:     "Own leads and assigned tasks only",
  floor_manager: "Spaces, bookings, waivers, contracts, and petty cash operations",
  accounts:      "Billing statements, invoicing, and payment confirmation",
  fms:           "Procurement dashboard, purchase requests, and facility operations",
  office_admin:  "Vendor management, purchase requests, and reorder configuration",
  it_team:       "IT support, technical coordination, and system access management",
};

// Feature matrix: rows = modules, cols = roles
// "full" | "limited" | "none"
type Access = "full" | "limited" | "none";

const FEATURE_MATRIX: Array<{
  module: string;
  rows: Array<{ feature: string; access: Record<string, Access> }>;
}> = [
  {
    module: "Team & Users",
    rows: [
      {
        feature: "View team members",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Create / edit / suspend users",
        access: { admin: "full", manager: "none", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
  {
    module: "Leads & CRM",
    rows: [
      {
        feature: "View & manage all leads",
        access: { admin: "full", manager: "full", sales_rep: "limited", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Import leads",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Activities & tasks",
        access: { admin: "full", manager: "full", sales_rep: "limited", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
  {
    module: "Spaces & Bookings",
    rows: [
      {
        feature: "View & manage bookings",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "full", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Waiver requests",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "full", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Space configuration",
        access: { admin: "full", manager: "none", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
  {
    module: "Contracts & Proposals",
    rows: [
      {
        feature: "View & manage contracts",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "full", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Contract payments",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "full", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
  {
    module: "Billing & Invoicing",
    rows: [
      {
        feature: "View billing statements",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "full", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Confirm & lock invoices",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "full", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
  {
    module: "Petty Cash",
    rows: [
      {
        feature: "View & add petty cash entries",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Approve entries",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
  {
    module: "Procurement",
    rows: [
      {
        feature: "View procurement dashboard",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "full", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Raise purchase requests",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "full", office_admin: "full", it_team: "none" },
      },
      {
        feature: "Approve purchase requests",
        access: { admin: "full", manager: "limited", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Vendor & bill management",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "full", it_team: "none" },
      },
    ],
  },
  {
    module: "Support Tickets",
    rows: [
      {
        feature: "Raise support tickets",
        access: { admin: "full", manager: "full", sales_rep: "full", floor_manager: "full", accounts: "full", fms: "full", office_admin: "full", it_team: "full" },
      },
      {
        feature: "Manage all tickets",
        access: { admin: "full", manager: "full", sales_rep: "limited", floor_manager: "limited", accounts: "limited", fms: "limited", office_admin: "limited", it_team: "full" },
      },
    ],
  },
  {
    module: "Settings & Configuration",
    rows: [
      {
        feature: "System settings",
        access: { admin: "full", manager: "none", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
      {
        feature: "Services & reorder config",
        access: { admin: "full", manager: "full", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "full", it_team: "none" },
      },
      {
        feature: "Audit logs",
        access: { admin: "full", manager: "none", sales_rep: "none", floor_manager: "none", accounts: "none", fms: "none", office_admin: "none", it_team: "none" },
      },
    ],
  },
];

const ALL_ROLES = [
  { key: "admin",         label: "Admin" },
  { key: "manager",       label: "Manager" },
  { key: "sales_rep",     label: "Sales Rep" },
  { key: "floor_manager", label: "Floor Incharge" },
  { key: "accounts",      label: "Accounts" },
  { key: "fms",           label: "Facility Mgr" },
  { key: "office_admin",  label: "Office Admin" },
  { key: "it_team",       label: "IT Team" },
];

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
  const [createdCredentials, setCreatedCredentials] = useState<{
    name: string; email: string; password: string; role: string;
  } | null>(null);
  const [copiedCreate, setCopiedCreate] = useState(false);

  // Change password dialog state
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<UserType | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [changedPasswordValue, setChangedPasswordValue] = useState("");
  const [copiedPassword, setCopiedPassword] = useState(false);

  // Edit user dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserType | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: "",
    phone: "",
    role: "sales_rep",
  });
  const [editing, setEditing] = useState(false);

  // Activity log dialog state
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [activityLogTarget, setActivityLogTarget] = useState<UserType | null>(null);

  // Share login details dialog state
  const [shareDetailsOpen, setShareDetailsOpen] = useState(false);
  const [shareDetailsTarget, setShareDetailsTarget] = useState<UserType | null>(null);
  const [copiedShareDetails, setCopiedShareDetails] = useState(false);

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
    // Fetch current user role via server-side API (bypasses browser extension blocks on supabase.co)
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => setCurrentUserRole(json.role || null))
      .catch(() => setCurrentUserRole(null));
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
    if (!createForm.email || !createForm.full_name || !createForm.password || !createForm.phone.trim()) {
      toast.error("Please fill all required fields including mobile number");
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
      // Show credential sharing view instead of closing
      setCreatedCredentials({
        name: createForm.full_name,
        email: createForm.email,
        password: createForm.password,
        role: USER_ROLE_LABELS[createForm.role] || createForm.role,
      });
      setCopiedCreate(false);
      fetchUsers();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create user");
    }
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app";

  const buildCreateCredentialMessage = () => {
    if (!createdCredentials) return "";
    return [
      `Welcome to TheWorkVilla CRM!`,
      ``,
      `Hi ${createdCredentials.name},`,
      ``,
      `Your login credentials:`,
      `URL: ${appUrl}/login`,
      `Email: ${createdCredentials.email}`,
      `Password: ${createdCredentials.password}`,
      `Role: ${createdCredentials.role}`,
      ``,
      `Please change your password after your first login.`,
    ].join("\n");
  };

  const handleCopyCreateCredentials = async () => {
    const msg = buildCreateCredentialMessage();
    await navigator.clipboard.writeText(msg);
    setCopiedCreate(true);
    toast.success("Credentials copied to clipboard");
    setTimeout(() => setCopiedCreate(false), 2000);
  };

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreatedCredentials(null);
    setCopiedCreate(false);
    setCreateForm({ full_name: "", email: "", password: "", role: "sales_rep", phone: "" });
    setShowCreatePassword(false);
  };

  // --- Share login details (no password) ---
  const openShareDetailsDialog = (member: UserType) => {
    setShareDetailsTarget(member);
    setCopiedShareDetails(false);
    setShareDetailsOpen(true);
    setOpenMenuId(null);
  };

  const buildShareDetailsMessage = () => {
    if (!shareDetailsTarget) return "";
    const roleName = USER_ROLE_LABELS[shareDetailsTarget.role] || shareDetailsTarget.role;
    return [
      `TheWorkVilla CRM — Login Details`,
      ``,
      `Hi ${shareDetailsTarget.full_name},`,
      ``,
      `Here are your login details:`,
      `URL: ${appUrl}/login`,
      `Email: ${shareDetailsTarget.email}`,
      `Role: ${roleName}`,
      ``,
      `If you've forgotten your password, please contact your admin for a reset.`,
    ].join("\n");
  };

  const handleCopyShareDetails = async () => {
    const msg = buildShareDetailsMessage();
    await navigator.clipboard.writeText(msg);
    setCopiedShareDetails(true);
    toast.success("Login details copied to clipboard");
    setTimeout(() => setCopiedShareDetails(false), 2000);
  };

  const buildPasswordCredentialMessage = () => {
    if (!passwordTarget) return "";
    return [
      `TheWorkVilla CRM - Password Updated`,
      ``,
      `Hi ${passwordTarget.full_name},`,
      ``,
      `Your password has been updated:`,
      `URL: ${appUrl}/login`,
      `Email: ${passwordTarget.email}`,
      `New Password: ${changedPasswordValue}`,
      ``,
      `Please keep this secure and change it after login.`,
    ].join("\n");
  };

  const handleCopyPasswordCredentials = async () => {
    const msg = buildPasswordCredentialMessage();
    await navigator.clipboard.writeText(msg);
    setCopiedPassword(true);
    toast.success("Credentials copied to clipboard");
    setTimeout(() => setCopiedPassword(false), 2000);
  };

  const closePasswordDialog = () => {
    setPasswordOpen(false);
    setPasswordTarget(null);
    setNewPassword("");
    setChangedPasswordValue("");
    setPasswordChanged(false);
    setCopiedPassword(false);
    setShowNewPassword(false);
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
    setPasswordChanged(false);
    setChangedPasswordValue("");
    setCopiedPassword(false);
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
      // Show credential sharing view instead of closing
      setChangedPasswordValue(newPassword);
      setPasswordChanged(true);
      setCopiedPassword(false);
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

      {/* ── Role Legend ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Role Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ALL_ROLES.map(({ key, label }) => {
              const Icon = ROLE_ICONS[key] || User;
              return (
                <div
                  key={key}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className={`mt-0.5 shrink-0 ${ROLE_ICON_COLORS[key]}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <Badge
                      variant="secondary"
                      className={`mb-1 ${ROLE_COLORS[key]}`}
                    >
                      {label}
                    </Badge>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {ROLE_DESCRIPTIONS[key]}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Feature Access Matrix ── */}
      <Card>
        <CardHeader className="pb-3">
          <div>
            <CardTitle className="text-base">Feature Access Matrix</CardTitle>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Check className="h-3 w-3 text-green-600" /> Full access
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded-full bg-amber-400 text-[9px] leading-3 text-center text-white font-bold">~</span>
                Limited / own records only
              </span>
              <span className="flex items-center gap-1">
                <Minus className="h-3 w-3 text-muted-foreground" /> No access
              </span>
            </p>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground w-48 min-w-[180px]">
                    Feature
                  </th>
                  {ALL_ROLES.map(({ key, label }) => {
                    const Icon = ROLE_ICONS[key] || User;
                    return (
                      <th
                        key={key}
                        className="px-3 py-2.5 text-center font-medium min-w-[80px]"
                      >
                        <div className="flex flex-col items-center gap-1">
                          <Icon className={`h-3.5 w-3.5 ${ROLE_ICON_COLORS[key]}`} />
                          <span className="leading-tight">{label}</span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {FEATURE_MATRIX.map((section, si) => (
                  <>
                    {/* Module header row */}
                    <tr key={`section-${si}`} className="bg-muted/30 border-b">
                      <td
                        colSpan={ALL_ROLES.length + 1}
                        className="px-4 py-1.5 font-semibold text-[11px] uppercase tracking-wide text-muted-foreground"
                      >
                        {section.module}
                      </td>
                    </tr>
                    {section.rows.map((row, ri) => (
                      <tr
                        key={`row-${si}-${ri}`}
                        className="border-b hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {row.feature}
                        </td>
                        {ALL_ROLES.map(({ key }) => {
                          const access = row.access[key] ?? "none";
                          return (
                            <td key={key} className="px-3 py-2.5 text-center">
                              {access === "full" && (
                                <Check className="h-3.5 w-3.5 text-green-600 mx-auto" />
                              )}
                              {access === "limited" && (
                                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-700 font-bold text-[10px] mx-auto">
                                  ~
                                </span>
                              )}
                              {access === "none" && (
                                <Minus className="h-3.5 w-3.5 text-muted-foreground/40 mx-auto" />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
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
                <th className="px-4 py-3 text-center font-medium hidden md:table-cell">
                  Push
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
                    <td className="px-4 py-3 hidden md:table-cell text-center">
                      {(member as UserType & { push_enabled?: boolean }).push_enabled ? (
                        <BellRing className="h-4 w-4 text-green-600 inline-block" />
                      ) : (
                        <BellOff className="h-4 w-4 text-muted-foreground/50 inline-block" />
                      )}
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
                              <button
                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                                onClick={() => openShareDetailsDialog(member)}
                              >
                                <Share2 className="h-4 w-4" />
                                Share Login Details
                              </button>
                              <button
                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                                onClick={() => {
                                  setActivityLogTarget(member);
                                  setActivityLogOpen(true);
                                  setOpenMenuId(null);
                                }}
                              >
                                <Eye className="h-4 w-4" />
                                Activity Log
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
      <Dialog open={createOpen} onOpenChange={closeCreateDialog}>
        <DialogContent className="max-w-md">
          {createdCredentials ? (
            /* ── Success: share credentials ── */
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  Team Member Created
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Copy the credentials below and share via WhatsApp or email so
                  the user can log in.
                </p>
                <div className="rounded-lg border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap leading-relaxed">
                  {buildCreateCredentialMessage()}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeCreateDialog}>
                    Close
                  </Button>
                  <Button onClick={handleCopyCreateCredentials}>
                    {copiedCreate ? (
                      <CheckCheck className="mr-2 h-4 w-4" />
                    ) : (
                      <Copy className="mr-2 h-4 w-4" />
                    )}
                    {copiedCreate ? "Copied!" : "Copy Credentials"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            /* ── Form ── */
            <>
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
                  <Label htmlFor="create-phone">
                    Mobile Number <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="create-phone"
                    type="tel"
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
                      <SelectItem value="floor_manager">Floor Incharge</SelectItem>
                      <SelectItem value="accounts">Accounts</SelectItem>
                      <SelectItem value="fms">Facility Manager</SelectItem>
                      <SelectItem value="office_admin">Office Administrator</SelectItem>
                      <SelectItem value="it_team">IT Team</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeCreateDialog}
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
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Change Password Dialog ── */}
      <Dialog open={passwordOpen} onOpenChange={closePasswordDialog}>
        <DialogContent className="max-w-sm">
          {passwordChanged && passwordTarget ? (
            /* ── Success: share new password ── */
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  Password Updated
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Copy the credentials below and share via WhatsApp or email.
                </p>
                <div className="rounded-lg border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap leading-relaxed">
                  {buildPasswordCredentialMessage()}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={closePasswordDialog}>
                    Close
                  </Button>
                  <Button onClick={handleCopyPasswordCredentials}>
                    {copiedPassword ? (
                      <CheckCheck className="mr-2 h-4 w-4" />
                    ) : (
                      <Copy className="mr-2 h-4 w-4" />
                    )}
                    {copiedPassword ? "Copied!" : "Copy Credentials"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            /* ── Form ── */
            <>
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
                    onClick={closePasswordDialog}
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
            </>
          )}
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
                  <SelectItem value="floor_manager">Floor Incharge</SelectItem>
                  <SelectItem value="accounts">Accounts</SelectItem>
                  <SelectItem value="fms">Facility Manager</SelectItem>
                  <SelectItem value="office_admin">Office Administrator</SelectItem>
                  <SelectItem value="it_team">IT Team</SelectItem>
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

      {/* ── Share Login Details Dialog ── */}
      <Dialog open={shareDetailsOpen} onOpenChange={(open) => { if (!open) { setShareDetailsOpen(false); setShareDetailsTarget(null); setCopiedShareDetails(false); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-5 w-5 text-blue-600" />
              Share Login Details
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Copy the login details below and share via WhatsApp or email.
            </p>
            <div className="rounded-lg border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap leading-relaxed">
              {buildShareDetailsMessage()}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShareDetailsOpen(false); setShareDetailsTarget(null); setCopiedShareDetails(false); }}>
                Close
              </Button>
              <Button onClick={handleCopyShareDetails}>
                {copiedShareDetails ? (
                  <CheckCheck className="mr-2 h-4 w-4" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {copiedShareDetails ? "Copied!" : "Copy Details"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── User Activity Log Dialog ── */}
      {activityLogTarget && (
        <UserActivityLogDialog
          open={activityLogOpen}
          onOpenChange={setActivityLogOpen}
          userId={activityLogTarget.id}
          userName={activityLogTarget.full_name}
        />
      )}
    </div>
  );
}
