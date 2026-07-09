"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Download } from "lucide-react";

interface RegisterDef {
  key: string;
  title: string;
  docNo: string;
  description: string;
  endpoint: string;
}

const REGISTERS: RegisterDef[] = [
  {
    key: "facility-tickets",
    title: "Facilities Management Ticketing System",
    docNo: "SDI/OPFM/F/16",
    description: "Non-IT facility tickets — HVAC, plumbing, electrical, housekeeping, security, other.",
    endpoint: "/api/admin/iso-registers/facility-tickets",
  },
  {
    key: "it-tickets",
    title: "IT Ticket Register",
    docNo: "SDI/ITSS/F/05",
    description: "All IT-scope tickets — WiFi, printer, access card, network, CCTV.",
    endpoint: "/api/admin/iso-registers/it-tickets",
  },
  {
    key: "rfid-access-log",
    title: "RFID Door Access Log",
    docNo: "SDI/ITSS/F/10",
    description: "Every COSEC door swipe (granted or denied) with cardholder details resolved.",
    endpoint: "/api/admin/iso-registers/rfid-access-log",
  },
  {
    key: "it-assets",
    title: "IT Asset Register",
    docNo: "SDI/ITSS/F/01",
    description: "Every tracked facility/IT asset — make, model, serial, assignment, service schedule.",
    endpoint: "/api/admin/iso-registers/it-assets",
  },
  {
    key: "seat-occupancy",
    title: "Seat Occupancy Tracker",
    docNo: "SDI/OPFM/F/09",
    description: "Seat/cabin/desk assignments — client, LOI number, allocated vs. occupied vs. vacant.",
    endpoint: "/api/admin/iso-registers/seat-occupancy",
  },
  {
    key: "conference-bookings",
    title: "Conference Room Booking Calendar/Log",
    docNo: "SDI/OPFM/F/10",
    description: "Meeting room and day-pass bookings — purpose, attendees, LOI number, payment status.",
    endpoint: "/api/admin/iso-registers/conference-bookings",
  },
];

// toISOString() converts to UTC first, which shifts the date by a day in
// timezones behind UTC — build the "YYYY-MM-DD" string from local parts instead.
function toLocalIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstOfMonth(d: Date): string {
  return toLocalIsoDate(d.getFullYear(), d.getMonth(), 1);
}

function lastOfMonth(d: Date): string {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return toLocalIsoDate(last.getFullYear(), last.getMonth(), last.getDate());
}

export default function IsoRegistersPage() {
  const today = new Date();
  const [ranges, setRanges] = useState<Record<string, { from: string; to: string }>>(
    Object.fromEntries(REGISTERS.map((r) => [r.key, { from: firstOfMonth(today), to: lastOfMonth(today) }]))
  );

  const updateRange = (key: string, field: "from" | "to", value: string) => {
    setRanges((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileText className="h-6 w-6 text-teal-700" />
          ISO Registers
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Auditor-ready PDF exports of ISO 9001 registers, generated live from CRM data — no manual re-entry.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {REGISTERS.map((reg) => {
          const range = ranges[reg.key];
          const href = `${reg.endpoint}?from=${range.from}&to=${range.to}`;
          return (
            <Card key={reg.key}>
              <CardHeader>
                <CardTitle className="text-base">{reg.title}</CardTitle>
                <CardDescription className="font-mono text-xs">{reg.docNo}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{reg.description}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor={`${reg.key}-from`} className="text-xs">From</Label>
                    <Input
                      id={`${reg.key}-from`}
                      type="date"
                      value={range.from}
                      onChange={(e) => updateRange(reg.key, "from", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`${reg.key}-to`} className="text-xs">To</Label>
                    <Input
                      id={`${reg.key}-to`}
                      type="date"
                      value={range.to}
                      onChange={(e) => updateRange(reg.key, "to", e.target.value)}
                    />
                  </div>
                </div>
                <Button asChild className="w-full">
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    <Download className="h-4 w-4 mr-2" />
                    Download PDF
                  </a>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
