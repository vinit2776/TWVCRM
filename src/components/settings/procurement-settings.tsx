"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ShoppingCart, CheckCircle2, XCircle, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface RoleRow {
  role: string;
  label: string;
  canRequestPR: boolean;
  canApproveBelow: boolean; // can approve when amount ≤ threshold
  canApproveAbove: boolean; // can approve when amount > threshold
  canManageVendors: boolean;
  canCreatePO: boolean;
}

function buildRoleMatrix(): RoleRow[] {
  return [
    {
      role: "admin",
      label: "Admin",
      canRequestPR: true,
      canApproveBelow: true,
      canApproveAbove: true,
      canManageVendors: true,
      canCreatePO: true,
    },
    {
      role: "manager",
      label: "Manager",
      canRequestPR: true,
      canApproveBelow: true,
      canApproveAbove: false, // blocked above threshold
      canManageVendors: true,
      canCreatePO: true,
    },
    {
      role: "floor_manager",
      label: "Floor Incharge",
      canRequestPR: true,
      canApproveBelow: false,
      canApproveAbove: false,
      canManageVendors: false,
      canCreatePO: false,
    },
    {
      role: "office_admin",
      label: "Office Administrator",
      canRequestPR: true,
      canApproveBelow: false,
      canApproveAbove: false,
      canManageVendors: true,
      canCreatePO: true,
    },
    {
      role: "sales_rep",
      label: "Sales Rep",
      canRequestPR: true,
      canApproveBelow: false,
      canApproveAbove: false,
      canManageVendors: false,
      canCreatePO: false,
    },
  ];
}

function Tick({ yes }: { yes: boolean }) {
  return yes ? (
    <CheckCircle2 className="h-4 w-4 text-green-600 mx-auto" />
  ) : (
    <XCircle className="h-4 w-4 text-gray-300 mx-auto" />
  );
}

export function ProcurementSettings() {
  const [threshold, setThreshold] = useState<string>("");
  const [savedThreshold, setSavedThreshold] = useState<number>(25000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/procurement/settings")
      .then((r) => r.json())
      .then((j) => {
        if (j.data?.approval_threshold != null) {
          setSavedThreshold(j.data.approval_threshold);
          setThreshold(String(j.data.approval_threshold));
        }
      })
      .catch(() => {
        setThreshold("25000");
      })
      .finally(() => setLoading(false));
  }, []);

  const parsedThreshold = parseInt(threshold, 10);
  const isValid = !isNaN(parsedThreshold) && parsedThreshold >= 0;
  const isDirty = isValid && parsedThreshold !== savedThreshold;

  const handleSave = async () => {
    if (!isValid) { toast.error("Please enter a valid amount"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/procurement/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: parsedThreshold }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save"); return; }
      setSavedThreshold(parsedThreshold);
      toast.success("Approval threshold updated");
    } finally {
      setSaving(false);
    }
  };

  const roleMatrix = buildRoleMatrix();
  const displayThreshold = isValid ? parsedThreshold : savedThreshold;

  return (
    <div className="space-y-6">
      {/* Threshold card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" />
            Approval Threshold
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Material Requests at or below this amount can be approved by a <strong>Manager</strong>.
                Requests exceeding this amount require an <strong>Admin</strong> to approve.
              </p>

              <div className="flex items-end gap-3">
                <div className="space-y-1.5 flex-1 max-w-xs">
                  <Label htmlFor="threshold">Admin-required above (₹)</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground shrink-0">₹</span>
                    <Input
                      id="threshold"
                      type="number"
                      min="0"
                      step="1000"
                      placeholder="25000"
                      value={threshold}
                      onChange={(e) => setThreshold(e.target.value)}
                      className="max-w-[160px]"
                    />
                  </div>
                  {isValid && (
                    <p className="text-xs text-muted-foreground">
                      Currently: <span className="font-medium">{formatCurrency(savedThreshold)}</span>
                    </p>
                  )}
                </div>
                <Button
                  onClick={handleSave}
                  disabled={saving || !isDirty}
                >
                  {saving ? <><Loader2 className="h-4 w-4 animate-spin mr-1" />Saving…</> : "Save"}
                </Button>
              </div>

              {isValid && parsedThreshold === 0 && (
                <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>Setting threshold to ₹0 means all PRs require admin approval, regardless of amount.</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Role matrix card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" />
            Role Permissions Matrix
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Shows what each role can do. The approval columns update live as you adjust the threshold above.
          </p>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Role</th>
                  <th className="px-3 py-3 text-center font-medium">Raise PR</th>
                  <th className="px-3 py-3 text-center font-medium">
                    <div>Approve</div>
                    <div className="text-xs font-normal text-muted-foreground">
                      ≤&nbsp;{formatCurrency(displayThreshold)}
                    </div>
                  </th>
                  <th className="px-3 py-3 text-center font-medium">
                    <div>Approve</div>
                    <div className="text-xs font-normal text-muted-foreground">
                      &gt;&nbsp;{formatCurrency(displayThreshold)}
                    </div>
                  </th>
                  <th className="px-3 py-3 text-center font-medium hidden sm:table-cell">Create PO</th>
                  <th className="px-3 py-3 text-center font-medium hidden sm:table-cell">Manage Vendors</th>
                </tr>
              </thead>
              <tbody>
                {roleMatrix.map((row, idx) => (
                  <tr key={row.role} className={idx % 2 === 0 ? "border-b" : "border-b bg-muted/20"}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={
                            row.role === "admin"
                              ? "bg-purple-100 text-purple-800"
                              : row.role === "manager"
                                ? "bg-blue-100 text-blue-800"
                                : row.role === "floor_manager"
                                  ? "bg-teal-100 text-teal-800"
                                  : "bg-gray-100 text-gray-700"
                          }
                        >
                          {row.label}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <Tick yes={row.canRequestPR} />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <Tick yes={row.canApproveBelow} />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <Tick yes={row.canApproveAbove} />
                    </td>
                    <td className="px-3 py-3 text-center hidden sm:table-cell">
                      <Tick yes={row.canCreatePO} />
                    </td>
                    <td className="px-3 py-3 text-center hidden sm:table-cell">
                      <Tick yes={row.canManageVendors} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <p className="font-medium">Approval Rules</p>
              <ul className="text-muted-foreground space-y-0.5">
                <li>• Manager can approve PRs up to <strong>{formatCurrency(displayThreshold)}</strong></li>
                <li>• Admin can approve any amount</li>
                <li>• Only the requester can submit/resubmit their own PR</li>
                <li>• Requester or manager/admin can cancel a PR</li>
              </ul>
            </div>
            <div className="space-y-1">
              <p className="font-medium">Visibility Rules</p>
              <ul className="text-muted-foreground space-y-0.5">
                <li>• Managers & admins see all PRs</li>
                <li>• Floor managers & sales reps see only their own</li>
                <li>• All roles can see the item catalog</li>
                <li>• Vendor bills visible to manager & admin only</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
