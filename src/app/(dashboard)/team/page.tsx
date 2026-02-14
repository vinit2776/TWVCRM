"use client";

import { useState, useEffect, useCallback } from "react";
import { Shield, ShieldCheck, User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { getInitials, formatDate } from "@/lib/utils";
import type { User as UserType } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  admin: ShieldCheck, manager: Shield, sales_rep: User,
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
    // Get current user's role
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

  const handleRoleChange = async (userId: string, newRole: string) => {
    const res = await fetch(`/api/users/${userId}`, {
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

  const handleToggleActive = async (userId: string, isActive: boolean) => {
    const res = await fetch(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !isActive }),
    });
    if (res.ok) {
      toast.success(isActive ? "User deactivated" : "User activated");
      fetchUsers();
    } else {
      toast.error("Failed to update user status");
    }
  };

  const isAdmin = currentUserRole === "admin";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Team Management</h1>
        <p className="text-sm text-muted-foreground">
          Manage team members and their roles
        </p>
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
          description="Team members appear here when they sign up."
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Member</th>
                <th className="px-4 py-3 text-left font-medium">Email</th>
                <th className="px-4 py-3 text-left font-medium">Role</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Status</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Joined</th>
                {isAdmin && (
                  <th className="px-4 py-3 text-left font-medium">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {users.map((member) => {
                const RoleIcon = ROLE_ICONS[member.role] || User;
                return (
                  <tr key={member.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs">
                            {getInitials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{member.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{member.email}</td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <Select
                          value={member.role}
                          onValueChange={(val) => handleRoleChange(member.id, val)}
                        >
                          <SelectTrigger className="w-[130px] h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="manager">Manager</SelectItem>
                            <SelectItem value="sales_rep">Sales Rep</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary" className={ROLE_COLORS[member.role]}>
                          <RoleIcon className="h-3 w-3 mr-1" />
                          {USER_ROLE_LABELS[member.role]}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <Badge variant={member.is_active ? "default" : "secondary"}>
                        {member.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      {formatDate(member.created_at)}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleActive(member.id, member.is_active)}
                        >
                          {member.is_active ? "Deactivate" : "Activate"}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
