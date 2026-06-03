"use client";

import { useState } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Wallet, ArrowUpCircle, ArrowDownCircle, ClipboardCheck, Users, BarChart3 } from "lucide-react";
import { MyBookTab } from "@/components/petty-cash/my-book-tab";
import { RequestsTab } from "@/components/petty-cash/requests-tab";
import { EntriesTab } from "@/components/petty-cash/entries-tab";
import { ApprovalsTab } from "@/components/petty-cash/approvals-tab";
import { AllBooksTab } from "@/components/petty-cash/all-books-tab";
import { AnalyticsTab } from "@/components/petty-cash/analytics-tab";

export default function PettyCashPage() {
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;

  const canApprove = userRole && ["admin", "manager", "accounts"].includes(userRole);
  const canViewAll = userRole && ["admin", "manager", "accounts"].includes(userRole);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Petty Cash</h1>
        <p className="text-muted-foreground">Manage your petty cash book, requests, and expenses</p>
      </div>

      <Tabs defaultValue="my-book">
        <TabsList className="flex-wrap">
          <TabsTrigger value="my-book" className="flex items-center gap-1.5">
            <Wallet className="h-3.5 w-3.5" />My Book
          </TabsTrigger>
          <TabsTrigger value="requests" className="flex items-center gap-1.5">
            <ArrowUpCircle className="h-3.5 w-3.5" />Requests
          </TabsTrigger>
          <TabsTrigger value="entries" className="flex items-center gap-1.5">
            <ArrowDownCircle className="h-3.5 w-3.5" />Expenses
          </TabsTrigger>
          {canApprove && (
            <TabsTrigger value="approvals" className="flex items-center gap-1.5">
              <ClipboardCheck className="h-3.5 w-3.5" />Approvals
            </TabsTrigger>
          )}
          {canViewAll && (
            <TabsTrigger value="all-books" className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />All Books
            </TabsTrigger>
          )}
          <TabsTrigger value="analytics" className="flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />Analytics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="my-book" className="mt-6">
          <MyBookTab />
        </TabsContent>
        <TabsContent value="requests" className="mt-6">
          <RequestsTab />
        </TabsContent>
        <TabsContent value="entries" className="mt-6">
          <EntriesTab />
        </TabsContent>
        {canApprove && (
          <TabsContent value="approvals" className="mt-6">
            <ApprovalsTab userRole={userRole!} />
          </TabsContent>
        )}
        {canViewAll && (
          <TabsContent value="all-books" className="mt-6">
            <AllBooksTab />
          </TabsContent>
        )}
        <TabsContent value="analytics" className="mt-6">
          <AnalyticsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
