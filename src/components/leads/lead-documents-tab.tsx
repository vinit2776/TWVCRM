"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Upload,
  FileText,
  File,
  Image,
  FolderOpen,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { formatDate } from "@/lib/utils";
import type { CrmDocument } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType === "application/pdf") return FileText;
  if (mimeType.startsWith("image/")) return Image;
  return File;
}

interface LeadDocumentsTabProps {
  leadId: string;
}

export function LeadDocumentsTab({ leadId }: LeadDocumentsTabProps) {
  const [documents, setDocuments] = useState<(CrmDocument & { uploader?: { full_name: string } })[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/documents?lead_id=${leadId}`);
    if (res.ok) {
      const json = await res.json();
      setDocuments(json.data || []);
    }
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", file.name);
    formData.append("lead_id", leadId);

    const res = await fetch("/api/documents", {
      method: "POST",
      body: formData,
    });

    setUploading(false);
    if (res.ok) {
      toast.success("Document uploaded and linked to lead");
      fetchDocuments();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to upload document");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownload = async (doc: CrmDocument) => {
    const supabase = createClient();
    const { data } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(doc.file_path, 60);

    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    }
  };

  if (loading) {
    return <TableSkeleton rows={3} />;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Documents</CardTitle>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleUpload}
          />
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="mr-2 h-4 w-4" />
            {uploading ? "Uploading..." : "Upload"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No documents attached"
            description="Upload documents for this lead."
            actionLabel="Upload Document"
            onAction={() => fileInputRef.current?.click()}
          />
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Category</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Size</th>
                  <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Date</th>
                  <th className="px-4 py-3 text-left font-medium w-20"></th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  const Icon = getFileIcon(doc.mime_type);
                  return (
                    <tr key={doc.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="font-medium truncate">{doc.title}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <Badge variant="secondary">{doc.category || "general"}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {formatFileSize(doc.size_bytes)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                        {formatDate(doc.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDownload(doc)}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
