"use client";

import Link from "next/link";
import { ShoppingCart, ClipboardList, Package, Receipt, Truck, Archive, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const modules = [
  {
    href: "/procurement/requests",
    icon: ClipboardList,
    title: "Material Requests",
    description: "Raise and track material requests from any department. Submit for manager or admin approval.",
    badge: "Sprint 2",
    badgeColor: "bg-yellow-100 text-yellow-800",
  },
  {
    href: "/procurement/orders",
    icon: Package,
    title: "Purchase Orders",
    description: "Convert approved requests into purchase orders. Assign vendors and track delivery status.",
    badge: "Sprint 3",
    badgeColor: "bg-yellow-100 text-yellow-800",
  },
  {
    href: "/procurement/bills",
    icon: Receipt,
    title: "Vendor Bills",
    description: "Record vendor invoices and track payments. Maintain a full payment history per supplier.",
    badge: "Sprint 3",
    badgeColor: "bg-yellow-100 text-yellow-800",
  },
  {
    href: "/procurement/vendors",
    icon: Truck,
    title: "Vendor Directory",
    description: "Manage your supplier contacts. Store GST details, payment terms, and contact information.",
    badge: "Live",
    badgeColor: "bg-green-100 text-green-800",
  },
  {
    href: "/procurement/catalog",
    icon: Archive,
    title: "Item Catalog",
    description: "Pre-seeded catalog of pantry, maintenance, and admin items. Add custom items as needed.",
    badge: "Live",
    badgeColor: "bg-green-100 text-green-800",
  },
];

export default function ProcurementPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShoppingCart className="h-6 w-6" />
          Procurement
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage purchases across Pantry, Maintenance, and Administration departments with full approval workflows and cost tracking.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {modules.map((mod) => (
          <Link key={mod.href} href={mod.href}>
            <Card className="h-full hover:shadow-md transition-shadow cursor-pointer group">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <mod.icon className="h-6 w-6 text-muted-foreground group-hover:text-foreground transition-colors" />
                  <Badge className={mod.badgeColor}>{mod.badge}</Badge>
                </div>
                <CardTitle className="text-base mt-2">{mod.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{mod.description}</p>
                <div className="flex items-center gap-1 mt-3 text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                  Open <ArrowRight className="h-3 w-3" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
