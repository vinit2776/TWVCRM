"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { LayoutDashboard, ArrowUp, ArrowDown, RotateCcw, Save, Loader2 } from "lucide-react";
import {
  WIDGET_REGISTRY,
  DASHBOARD_ROLE_WIDGETS,
  type WidgetId,
} from "@/lib/dashboard-config";
import { USER_ROLES, USER_ROLE_LABELS } from "@/lib/constants";
import type { UserRole } from "@/types";

const ALL_WIDGET_IDS = Object.keys(WIDGET_REGISTRY) as WidgetId[];

interface RoleConfig {
  enabled: WidgetId[];
}

export function DashboardSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedRole, setSelectedRole] = useState<UserRole>("admin");
  const [config, setConfig] = useState<Record<UserRole, WidgetId[]>>(
    {} as Record<UserRole, WidgetId[]>
  );

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/dashboard");
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      } else {
        // Fall back to hardcoded defaults
        setConfig({ ...DASHBOARD_ROLE_WIDGETS });
      }
    } catch {
      setConfig({ ...DASHBOARD_ROLE_WIDGETS });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const currentWidgets = config[selectedRole] || DASHBOARD_ROLE_WIDGETS[selectedRole] || [];

  const isEnabled = (widgetId: WidgetId) => currentWidgets.includes(widgetId);

  const toggleWidget = (widgetId: WidgetId) => {
    const current = [...currentWidgets];
    const idx = current.indexOf(widgetId);
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(widgetId);
    }
    setConfig((prev) => ({ ...prev, [selectedRole]: current }));
  };

  const moveWidget = (widgetId: WidgetId, direction: "up" | "down") => {
    const current = [...currentWidgets];
    const idx = current.indexOf(widgetId);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= current.length) return;
    [current[idx], current[newIdx]] = [current[newIdx], current[idx]];
    setConfig((prev) => ({ ...prev, [selectedRole]: current }));
  };

  const resetToDefaults = () => {
    setConfig((prev) => ({
      ...prev,
      [selectedRole]: [...DASHBOARD_ROLE_WIDGETS[selectedRole]],
    }));
    toast.info(`Reset ${USER_ROLE_LABELS[selectedRole]} to default widgets`);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/dashboard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: selectedRole,
          widgets: currentWidgets,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save");
      }
      toast.success(`Dashboard updated for ${USER_ROLE_LABELS[selectedRole]}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Separate enabled (ordered) and disabled widgets
  const enabledWidgets = currentWidgets.filter((id) =>
    ALL_WIDGET_IDS.includes(id)
  );
  const disabledWidgets = ALL_WIDGET_IDS.filter(
    (id) => !currentWidgets.includes(id)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <LayoutDashboard className="h-4 w-4" />
          Dashboard Widget Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Configure which widgets each role sees on their dashboard and in what
          order. Changes take effect immediately for all users of that role.
        </p>

        <Tabs
          value={selectedRole}
          onValueChange={(v) => setSelectedRole(v as UserRole)}
        >
          <TabsList className="flex-wrap h-auto gap-1">
            {USER_ROLES.map((role) => (
              <TabsTrigger key={role} value={role} className="text-xs">
                {USER_ROLE_LABELS[role] || role}
              </TabsTrigger>
            ))}
          </TabsList>

          {USER_ROLES.map((role) => (
            <TabsContent key={role} value={role} className="mt-4 space-y-4">
              {/* Enabled widgets — ordered */}
              {enabledWidgets.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Visible widgets (drag order = display order)
                  </p>
                  {enabledWidgets.map((widgetId, idx) => (
                    <div
                      key={widgetId}
                      className="flex items-center gap-3 rounded-md border px-3 py-2 bg-background hover:bg-accent/50 transition-colors"
                    >
                      <Checkbox
                        checked={true}
                        onCheckedChange={() => toggleWidget(widgetId)}
                      />
                      <span className="text-sm font-medium flex-1">
                        {WIDGET_REGISTRY[widgetId]?.title || widgetId}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={idx === 0}
                          onClick={() => moveWidget(widgetId, "up")}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={idx === enabledWidgets.length - 1}
                          onClick={() => moveWidget(widgetId, "down")}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Disabled widgets */}
              {disabledWidgets.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Available widgets (not shown)
                  </p>
                  {disabledWidgets.map((widgetId) => (
                    <div
                      key={widgetId}
                      className="flex items-center gap-3 rounded-md border border-dashed px-3 py-2 opacity-60 hover:opacity-100 transition-opacity"
                    >
                      <Checkbox
                        checked={false}
                        onCheckedChange={() => toggleWidget(widgetId)}
                      />
                      <span className="text-sm flex-1">
                        {WIDGET_REGISTRY[widgetId]?.title || widgetId}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3 pt-2">
                <Button onClick={handleSave} disabled={saving} size="sm">
                  {saving ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-3.5 w-3.5" />
                  )}
                  {saving ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetToDefaults}
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />
                  Reset to Defaults
                </Button>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
