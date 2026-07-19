"use client";

import { useState, useEffect } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client"; // still needed for handleSave
import { getInitials } from "@/lib/utils";
import { toast } from "sonner";
import { User, Mail, Phone, Shield, CreditCard, DoorOpen, FolderOpen, ArrowRight, ShoppingCart, LayoutDashboard, Banknote, AlertTriangle, PieChart, FileText, Sparkles } from "lucide-react";
import { PaymentGatewaySettings } from "@/components/settings/payment-gateway-settings";
import { FacilityClassifierSettings } from "@/components/settings/facility-classifier-settings";
import { ProcurementSettings } from "@/components/settings/procurement-settings";
import { DashboardSettings } from "@/components/settings/dashboard-settings";
import { PettyCashSettings } from "@/components/settings/petty-cash-settings";
import { ReorderSettings } from "@/components/settings/reorder-settings";
import { ProcurementBudgetSettings } from "@/components/settings/procurement-budget-settings";
import { EInvoiceSettings } from "@/components/settings/e-invoice-settings";
import Link from "next/link";

export default function SettingsPage() {
  const { user, loading } = useCurrentUser();
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState({
    full_name: "",
    email: "",
    phone: "",
    role: "",
  });

  useEffect(() => {
    if (!loading && user) {
      setProfile({
        full_name: user.full_name || "",
        email: user.email || "",
        phone: user.phone || "",
        role: user.role || "",
      });
    }
  }, [loading, user]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase
        .from("users")
        .update({
          full_name: profile.full_name,
          phone: profile.phone,
        })
        .eq("auth_id", user.id);

      if (error) throw error;
      toast.success("Profile updated successfully");
    } catch {
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Manage your account and preferences</p>
        </div>
        <div className="animate-pulse space-y-4">
          <div className="h-64 rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  const roleLabel =
    profile.role === "admin"
      ? "Admin"
      : profile.role === "manager"
        ? "Manager"
        : profile.role === "floor_manager"
          ? "Floor Incharge"
          : "Sales Rep";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="profile" orientation="vertical" className="flex flex-col md:flex-row gap-4 md:gap-6 w-full">
        <TabsList className="flex flex-col h-auto w-full md:w-52 shrink-0 items-stretch bg-muted/50 p-1 rounded-lg">
          <TabsTrigger value="profile" className="justify-start gap-2 px-3 py-2 text-sm">
            <User className="h-4 w-4 shrink-0" />Profile
          </TabsTrigger>
          {profile.role === "admin" && (
            <TabsTrigger value="payment-gateway" className="justify-start gap-2 px-3 py-2 text-sm">
              <CreditCard className="h-4 w-4 shrink-0" />Payment Gateway
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="spaces" className="justify-start gap-2 px-3 py-2 text-sm">
              <DoorOpen className="h-4 w-4 shrink-0" />Spaces
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="documents" className="justify-start gap-2 px-3 py-2 text-sm">
              <FolderOpen className="h-4 w-4 shrink-0" />Documents
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="procurement" className="justify-start gap-2 px-3 py-2 text-sm">
              <ShoppingCart className="h-4 w-4 shrink-0" />Procurement
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="dashboard-config" className="justify-start gap-2 px-3 py-2 text-sm">
              <LayoutDashboard className="h-4 w-4 shrink-0" />Dashboard
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="petty-cash" className="justify-start gap-2 px-3 py-2 text-sm">
              <Banknote className="h-4 w-4 shrink-0" />Petty Cash
            </TabsTrigger>
          )}
          {["admin", "manager"].includes(profile.role) && (
            <TabsTrigger value="reorder-levels" className="justify-start gap-2 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />Reorder Levels
            </TabsTrigger>
          )}
          {["admin", "manager"].includes(profile.role) && (
            <TabsTrigger value="dept-budgets" className="justify-start gap-2 px-3 py-2 text-sm">
              <PieChart className="h-4 w-4 shrink-0" />Budgets
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="e-invoicing" className="justify-start gap-2 px-3 py-2 text-sm">
              <FileText className="h-4 w-4 shrink-0" />E-Invoicing
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="facility-classifier" className="justify-start gap-2 px-3 py-2 text-sm">
              <Sparkles className="h-4 w-4 shrink-0" />Facility Classifier
            </TabsTrigger>
          )}
        </TabsList>

        <div className="flex-1 min-w-0">
        <TabsContent value="profile" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <User className="h-4 w-4" />
                Profile Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarFallback className="text-lg">
                    {getInitials(profile.full_name || "U")}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{profile.full_name}</p>
                  <p className="text-sm text-muted-foreground">{profile.email}</p>
                </div>
              </div>

              <Separator />

              <div className="grid gap-4">
                <div className="space-y-2">
                  <Label htmlFor="full_name">Full Name</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="full_name"
                      value={profile.full_name}
                      onChange={(e) =>
                        setProfile({ ...profile, full_name: e.target.value })
                      }
                      className="pl-9"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      value={profile.email}
                      disabled
                      className="pl-9 bg-muted"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Email cannot be changed from here
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="phone"
                      value={profile.phone}
                      onChange={(e) =>
                        setProfile({ ...profile, phone: e.target.value })
                      }
                      className="pl-9"
                      placeholder="+91 XXXXX XXXXX"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Role</Label>
                  <div className="relative">
                    <Shield className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={roleLabel}
                      disabled
                      className="pl-9 bg-muted"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Role can only be changed by an admin
                  </p>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {profile.role === "admin" && (
          <TabsContent value="payment-gateway" className="mt-0">
            <PaymentGatewaySettings />
          </TabsContent>
        )}

        {profile.role === "admin" && (
          <TabsContent value="spaces" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <DoorOpen className="h-4 w-4" />
                  Spaces Management
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Manage coworking spaces, meeting rooms, and their configurations including
                  capacity, hourly rates, operating hours, and facilities.
                </p>
                <Button asChild>
                  <Link href="/spaces">
                    Go to Spaces
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {profile.role === "admin" && (
          <TabsContent value="documents" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FolderOpen className="h-4 w-4" />
                  Documents Management
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Upload, organize, and manage documents including contracts, identity proofs,
                  proposals, invoices, and general files.
                </p>
                <Button asChild>
                  <Link href="/documents">
                    Go to Documents
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {profile.role === "admin" && (
          <TabsContent value="procurement" className="mt-0">
            <ProcurementSettings />
          </TabsContent>
        )}

        {profile.role === "admin" && (
          <TabsContent value="dashboard-config" className="mt-0">
            <DashboardSettings />
          </TabsContent>
        )}

        {profile.role === "admin" && (
          <TabsContent value="petty-cash" className="mt-0">
            <PettyCashSettings />
          </TabsContent>
        )}

        {["admin", "manager"].includes(profile.role) && (
          <TabsContent value="reorder-levels" className="mt-0">
            <ReorderSettings />
          </TabsContent>
        )}
        {["admin", "manager"].includes(profile.role) && (
          <TabsContent value="dept-budgets" className="mt-0">
            <ProcurementBudgetSettings userRole={profile.role} />
          </TabsContent>
        )}
        {profile.role === "admin" && (
          <TabsContent value="e-invoicing" className="mt-0">
            <EInvoiceSettings />
          </TabsContent>
        )}
        {profile.role === "admin" && (
          <TabsContent value="facility-classifier" className="mt-0">
            <FacilityClassifierSettings />
          </TabsContent>
        )}
        </div>
      </Tabs>
    </div>
  );
}
