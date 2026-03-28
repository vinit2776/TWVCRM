"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePettyCashBooks } from "@/hooks/use-petty-cash";

export function AllBooksTab() {
  const { data: books, loading } = usePettyCashBooks({ all: true });

  if (loading) {
    return <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded bg-muted" />)}</div>;
  }

  const totalBalance = books.reduce((sum, b) => sum + Number(b.current_balance), 0);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Total Float Outstanding</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">₹{totalBalance.toLocaleString("en-IN")}</div>
          <p className="text-sm text-muted-foreground mt-1">Across {books.length} book(s)</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All Petty Cash Books</CardTitle>
        </CardHeader>
        <CardContent>
          {books.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No books created yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Person</th>
                    <th className="pb-2 font-medium text-muted-foreground">Email</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Role</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {books.map((b) => (
                    <tr key={b.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2.5 font-medium">{b.owner?.full_name || "—"}</td>
                      <td className="py-2.5 text-muted-foreground">{b.owner?.email || "—"}</td>
                      <td className="py-2.5 hidden md:table-cell text-muted-foreground capitalize">{b.owner?.role || "—"}</td>
                      <td className="py-2.5 text-right font-medium">
                        ₹{Number(b.current_balance).toLocaleString("en-IN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
