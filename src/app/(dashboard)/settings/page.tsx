"use client";

import { useState, useEffect } from "react";
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
import { User, Mail, Phone, Shield, CreditCard, DoorOpen, FolderOpen, ArrowRight, ShoppingCart } from "lucide-react";
import { PaymentGatewaySettings } from "@/components/settings/payment-gateway-settings";
import { ProcurementSettings } from "@/components/settings/procurement-settings";
import Link from "next/link";

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState({
    full_name: "",
    email: "",
    phone: "",
    role: "",
  });

  useEffect(() => {
    // Fetch profile via server-side API (bypasses browser extension blocks on supabase.co)
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => {
        setProfile({
          full_name: json.full_name || "",
          email: json.email || "",
          phone: json.phone || "",
          role: json.role || "",
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
          ? "Floor Manager"
          : "Sales Rep";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="profile" className="max-w-3xl">
        <TabsList>
          <TabsTrigger value="profile" className="flex items-center gap-1.5">
            <User className="h-3.5 w-3.5" />Profile
          </TabsTrigger>
          {profile.role === "admin" && (
            <TabsTrigger value="payment-gateway" className="flex items-center gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />Payment Gateway
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="spaces" className="flex items-center gap-1.5">
              <DoorOpen className="h-3.5 w-3.5" />Spaces
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="documents" className="flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5" />Documents
            </TabsTrigger>
          )}
          {profile.role === "admin" && (
            <TabsTrigger value="procurement" className="flex items-center gap-1.5">
              <ShoppingCart className="h-3.5 w-3.5" />Procurement
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile" className="mt-6">
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
          <TabsContent value="payment-gateway" className="mt-6">
            <PaymentGatewaySettings />
          </TabsContent>
        )}

        {profile.role === "admin" && (
          <TabsContent value="spaces" className="mt-6">
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
          <TabsContent value="documents" className="mt-6">
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
          <TabsContent value="procurement" className="mt-6">
            <ProcurementSettings />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
