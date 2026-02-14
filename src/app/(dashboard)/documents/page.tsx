import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";

export default function DocumentsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Documents</h1>
          <p className="text-muted-foreground">Manage your document repository</p>
        </div>
        <Button>
          <Upload className="h-4 w-4" />
          Upload Document
        </Button>
      </div>
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No documents yet. Upload your first document.</p>
      </div>
    </div>
  );
}
