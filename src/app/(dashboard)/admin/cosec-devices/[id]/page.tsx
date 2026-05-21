"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Wifi,
  WifiOff,
  Loader2,
  ArrowLeft,
  ShieldCheck,
  ShieldOff,
  Fingerprint,
  CreditCard,
  Clock,
  DoorOpen,
  RefreshCw,
  LogIn,
  LogOut,
  Ban,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Device {
  id: string;
  label: string;
  device_ip: string;
  device_port: number;
  is_enabled: boolean;
  last_ping_at: string | null;
  last_ping_success: boolean | null;
  last_polled_at: string | null;
  last_seq_number: number;
  location: { name: string };
}

interface AccessUser {
  id: string;
  cosec_user_id: string;
  cosec_ref_id: number;
  user_type: "contract" | "employee" | "booking";
  entity_id: string;
  enrollment_status: string;
  nfc_card_number: string | null;
  access_pin: string | null;
  valid_until: string | null;
  provisioned_at: string | null;
  biometric_enrolled_at: string | null;
  card_enrolled_at: string | null;
  blocked_at: string | null;
  deleted_at: string | null;
  entity_name?: string;
}

interface AccessLog {
  id: string;
  cosec_ref_id: number;
  user_type: string;
  direction: "IN" | "OUT" | "DENIED";
  raw_event_id: number;
  event_time: string;
  device_seq_number: number;
  entity_name?: string;
}

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
  pending:            { label: "Pending",           variant: "secondary",    icon: <Clock size={12} /> },
  provisioned:        { label: "Provisioned",       variant: "outline",      icon: <ShieldCheck size={12} /> },
  biometric_enrolled: { label: "Biometric Enrolled",variant: "default",      icon: <Fingerprint size={12} /> },
  card_enrolled:      { label: "Card Enrolled",     variant: "default",      icon: <CreditCard size={12} /> },
  fully_enrolled:     { label: "Fully Enrolled",    variant: "default",      icon: <ShieldCheck size={12} /> },
  blocked:            { label: "Blocked",           variant: "destructive",  icon: <ShieldOff size={12} /> },
  deleted:            { label: "Deleted",           variant: "secondary",    icon: <Ban size={12} /> },
};

const TYPE_LABELS: Record<string, string> = {
  contract: "Contract",
  employee: "Employee",
  booking:  "Walk-in Booking",
};

export default function CosecDeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [device, setDevice] = useState<Device | null>(null);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<{ ok: boolean; deviceName?: string; latencyMs?: number; error?: string } | null>(null);
  const [openingDoor, setOpeningDoor] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: dev }, { data: accessUsers }, { data: accessLogs }] = await Promise.all([
      supabase
        .from("cosec_devices")
        .select("*, location:locations(name)")
        .eq("id", id)
        .single(),
      supabase
        .from("cosec_access_users")
        .select("*")
        .eq("device_id", id)
        .neq("enrollment_status", "deleted")
        .order("provisioned_at", { ascending: false }),
      supabase
        .from("access_logs")
        .select("*")
        .eq("device_id", id)
        .order("event_time", { ascending: false })
        .limit(100),
    ]);

    if (!dev) { router.push("/admin/cosec-devices"); return; }
    setDevice(dev as Device);

    // Enrich access users with entity names
    if (accessUsers) {
      const enriched = await enrichUsers(accessUsers as AccessUser[]);
      setUsers(enriched);

      // Enrich logs with names from enriched users
      if (accessLogs) {
        const refMap: Record<number, string> = {};
        enriched.forEach(u => { refMap[u.cosec_ref_id] = u.entity_name || u.cosec_user_id; });
        setLogs((accessLogs as AccessLog[]).map(l => ({ ...l, entity_name: refMap[l.cosec_ref_id] })));
      }
    }

    setLoading(false);
  }, [id, supabase, router]);

  async function enrichUsers(rawUsers: AccessUser[]): Promise<AccessUser[]> {
    const contractIds = rawUsers.filter(u => u.user_type === "contract").map(u => u.entity_id);
    const employeeIds = rawUsers.filter(u => u.user_type === "employee").map(u => u.entity_id);
    const bookingIds  = rawUsers.filter(u => u.user_type === "booking").map(u => u.entity_id);

    const [contracts, employees, bookings] = await Promise.all([
      contractIds.length
        ? supabase.from("contracts").select("id, contract_number, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)").in("id", contractIds)
        : { data: [] },
      employeeIds.length
        ? supabase.from("employees").select("id, full_name").in("id", employeeIds)
        : { data: [] },
      bookingIds.length
        ? supabase.from("bookings").select("id, booking_number").in("id", bookingIds)
        : { data: [] },
    ]);

    const nameMap: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (contracts.data || []).forEach((c: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = Array.isArray(c.lead) ? c.lead[0] : c.lead as any;
      nameMap[c.id] = (lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || c.contract_number);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (employees.data || []).forEach((e: any) => { nameMap[e.id] = e.full_name; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bookings.data || []).forEach((b: any) => { nameMap[b.id] = `Booking #${b.booking_number}`; });

    return rawUsers.map(u => ({ ...u, entity_name: nameMap[u.entity_id] || u.cosec_user_id }));
  }

  useEffect(() => { load(); }, [load]);

  async function handlePing() {
    setPinging(true);
    setPingResult(null);
    try {
      const res = await fetch("/api/cosec/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: id }),
      });
      const result = await res.json();
      setPingResult(result);
      if (result.ok) {
        toast.success(`Connected — ${result.deviceName} (${result.latencyMs}ms)`);
      } else {
        toast.error(`Unreachable: ${result.error}`);
      }
      await load();
    } finally {
      setPinging(false);
    }
  }

  async function handleOpenDoor() {
    setOpeningDoor(true);
    try {
      const res = await fetch("/api/cosec/open-door", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: id }),
      });
      const result = await res.json();
      if (result.ok) toast.success("Door opened");
      else toast.error(result.error || "Failed to open door");
    } finally {
      setOpeningDoor(false);
    }
  }

  async function handleBlock(user: AccessUser) {
    setActionLoading(a => ({ ...a, [user.id]: true }));
    try {
      const res = await fetch("/api/cosec/block-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: user.id }),
      });
      const result = await res.json();
      if (result.ok) { toast.success("Access blocked"); await load(); }
      else toast.error(result.error || "Failed");
    } finally {
      setActionLoading(a => ({ ...a, [user.id]: false }));
    }
  }

  async function handleRestore(user: AccessUser) {
    setActionLoading(a => ({ ...a, [user.id]: true }));
    try {
      const res = await fetch("/api/cosec/restore-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: user.id }),
      });
      const result = await res.json();
      if (result.ok) { toast.success("Access restored"); await load(); }
      else toast.error(result.error || "Failed");
    } finally {
      setActionLoading(a => ({ ...a, [user.id]: false }));
    }
  }

  async function handleReprovision(user: AccessUser) {
    setActionLoading(a => ({ ...a, [`reprov_${user.id}`]: true }));
    try {
      const res = await fetch("/api/cosec/provision-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: user.id }),
      });
      const result = await res.json();
      if (result.ok) { toast.success("Re-provisioned on device"); await load(); }
      else toast.error(result.error || "Failed");
    } finally {
      setActionLoading(a => ({ ...a, [`reprov_${user.id}`]: false }));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted-foreground" size={28} />
      </div>
    );
  }

  if (!device) return null;

  const isOnline = pingResult ? pingResult.ok : device.last_ping_success;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/admin/cosec-devices")} className="mt-0.5">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              {isOnline === true ? (
                <Wifi size={20} className="text-green-500" />
              ) : isOnline === false ? (
                <WifiOff size={20} className="text-red-500" />
              ) : (
                <Wifi size={20} className="text-muted-foreground opacity-40" />
              )}
              {device.label}
              <Badge variant={device.is_enabled ? "default" : "secondary"} className="text-xs">
                {device.is_enabled ? "Enabled" : "Disabled"}
              </Badge>
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {(device.location as { name: string })?.name} · {device.device_ip}:{device.device_port}
            </p>
            <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
              {device.last_ping_at && (
                <span>Last ping: {formatDate(device.last_ping_at)}</span>
              )}
              {device.last_polled_at && (
                <span>Last event poll: {formatDate(device.last_polled_at)}</span>
              )}
              <span>Seq #{device.last_seq_number}</span>
            </div>
            {pingResult && (
              <p className={`text-xs font-medium mt-1 ${pingResult.ok ? "text-green-600" : "text-red-500"}`}>
                {pingResult.ok
                  ? `✓ ${pingResult.deviceName} · ${pingResult.latencyMs}ms`
                  : `✗ ${pingResult.error}`}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={handlePing} disabled={pinging}>
            {pinging ? <Loader2 size={14} className="animate-spin mr-1" /> : <Wifi size={14} className="mr-1" />}
            Ping
          </Button>
          <Button size="sm" variant="outline" onClick={handleOpenDoor} disabled={openingDoor}>
            {openingDoor ? <Loader2 size={14} className="animate-spin mr-1" /> : <DoorOpen size={14} className="mr-1" />}
            Open Door
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(["provisioned", "biometric_enrolled", "card_enrolled", "fully_enrolled"] as const).map(status => {
          const count = users.filter(u => u.enrollment_status === status).length;
          const cfg = STATUS_CONFIG[status];
          return (
            <Card key={status} className="py-3">
              <CardContent className="px-4 py-0">
                <div className="flex items-center gap-2 text-muted-foreground text-xs">{cfg.icon}{cfg.label}</div>
                <div className="text-2xl font-semibold mt-1">{count}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Enrolled Users ({users.length})</TabsTrigger>
          <TabsTrigger value="logs">Access Log ({logs.length})</TabsTrigger>
        </TabsList>

        {/* Enrolled users */}
        <TabsContent value="users" className="mt-4">
          {users.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Fingerprint size={36} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">No users enrolled</p>
                <p className="text-sm mt-1">Users are provisioned automatically on contract activation.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {users.map(user => {
                const cfg = STATUS_CONFIG[user.enrollment_status] || STATUS_CONFIG.pending;
                const isBlocked = user.enrollment_status === "blocked";
                const isLoading = actionLoading[user.id];
                const isReprovLoading = actionLoading[`reprov_${user.id}`];

                return (
                  <Card key={user.id} className={isBlocked ? "opacity-60" : ""}>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm truncate">{user.entity_name}</span>
                            <Badge variant="outline" className="text-xs shrink-0">
                              {TYPE_LABELS[user.user_type]}
                            </Badge>
                            <Badge variant={cfg.variant} className="text-xs flex items-center gap-1 shrink-0">
                              {cfg.icon}{cfg.label}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                            <span>ID: {user.cosec_user_id}</span>
                            {user.valid_until && <span>Valid until: {formatDate(user.valid_until)}</span>}
                            {user.nfc_card_number && <span className="flex items-center gap-1"><CreditCard size={11} />{user.nfc_card_number}</span>}
                            {user.provisioned_at && <span>Provisioned: {formatDate(user.provisioned_at)}</span>}
                            {user.biometric_enrolled_at && <span>Biometric: {formatDate(user.biometric_enrolled_at)}</span>}
                            {user.blocked_at && <span className="text-red-500">Blocked: {formatDate(user.blocked_at)}</span>}
                          </div>
                        </div>
                        <div className="flex gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs"
                            onClick={() => handleReprovision(user)}
                            disabled={isReprovLoading}
                            title="Re-provision on device"
                          >
                            {isReprovLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          </Button>
                          {isBlocked ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs"
                              onClick={() => handleRestore(user)}
                              disabled={isLoading}
                            >
                              {isLoading ? <Loader2 size={13} className="animate-spin mr-1" /> : <ShieldCheck size={13} className="mr-1" />}
                              Restore
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs text-red-600 hover:text-red-700"
                              onClick={() => handleBlock(user)}
                              disabled={isLoading}
                            >
                              {isLoading ? <Loader2 size={13} className="animate-spin mr-1" /> : <ShieldOff size={13} className="mr-1" />}
                              Block
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Access log */}
        <TabsContent value="logs" className="mt-4">
          {logs.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Clock size={36} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">No access events yet</p>
                <p className="text-sm mt-1">Events will appear here once the cron starts polling the device.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="divide-y">
                  {logs.map(log => (
                    <div key={log.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="shrink-0">
                        {log.direction === "IN" ? (
                          <LogIn size={16} className="text-green-500" />
                        ) : log.direction === "OUT" ? (
                          <LogOut size={16} className="text-blue-500" />
                        ) : (
                          <Ban size={16} className="text-red-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-sm">{log.entity_name || `Ref #${log.cosec_ref_id}`}</span>
                        <span className="text-xs text-muted-foreground ml-2">{TYPE_LABELS[log.user_type] || log.user_type}</span>
                      </div>
                      <div className="text-right shrink-0">
                        <Badge
                          variant={log.direction === "DENIED" ? "destructive" : "outline"}
                          className="text-xs"
                        >
                          {log.direction}
                        </Badge>
                        <div className="text-xs text-muted-foreground mt-0.5">{formatDate(log.event_time)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
