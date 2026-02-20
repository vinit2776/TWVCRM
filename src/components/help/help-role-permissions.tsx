"use client";

import { Shield, Check, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RolePermission } from "@/lib/help-content";

interface HelpRolePermissionsProps {
  permissions: RolePermission[];
}

const roles = [
  { key: "admin" as const, label: "Admin" },
  { key: "manager" as const, label: "Manager" },
  { key: "sales_rep" as const, label: "Sales Rep" },
  { key: "floor_manager" as const, label: "Floor Mgr" },
];

export function HelpRolePermissions({ permissions }: HelpRolePermissionsProps) {
  return (
    <Card id="role-permissions" className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          Role Permissions
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          What each role can access in the CRM
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 text-left font-medium">Feature</th>
                {roles.map((role) => (
                  <th key={role.key} className="py-2 px-3 text-center font-medium whitespace-nowrap">
                    {role.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((perm, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 pr-4 text-muted-foreground">{perm.feature}</td>
                  {roles.map((role) => (
                    <td key={role.key} className="py-2 px-3 text-center">
                      {perm[role.key] ? (
                        <Check className="h-4 w-4 text-green-600 mx-auto" />
                      ) : (
                        <Minus className="h-4 w-4 text-muted-foreground/40 mx-auto" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
