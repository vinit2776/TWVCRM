"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Plus, Banknote } from "lucide-react";
import { toast } from "sonner";
import { usePettyCashCategories } from "@/hooks/use-petty-cash";

export function PettyCashSettings() {
  const { data: categories, loading, refetch } = usePettyCashCategories();
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/petty-cash/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success("Category added");
      setNewName("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch("/api/petty-cash/categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, is_active: isActive }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Banknote className="h-4 w-4" />
          Petty Cash Categories
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Manage expense categories used when logging petty cash expenses.
        </p>

        {/* Add new category */}
        <div className="flex gap-2">
          <Input
            placeholder="New category name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button size="sm" onClick={handleAdd} disabled={adding || !newName.trim()}>
            <Plus className="h-4 w-4 mr-1" />{adding ? "Adding..." : "Add"}
          </Button>
        </div>

        {/* Category list */}
        {loading ? (
          <div className="animate-pulse space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-muted" />)}</div>
        ) : (
          <div className="space-y-2">
            {categories.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between rounded-lg border px-4 py-2.5">
                <span className={cat.is_active ? "" : "text-muted-foreground line-through"}>{cat.name}</span>
                <Switch
                  checked={cat.is_active}
                  onCheckedChange={(checked) => handleToggle(cat.id, checked)}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
