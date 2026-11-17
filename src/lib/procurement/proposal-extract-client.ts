import type { ExtractedAmcProposal } from "@/lib/procurement/proposal-extraction";

/** Browser-side call to the read-only proposal reader. Resolves to null on any failure. */
export async function requestProposalExtraction(file: File): Promise<ExtractedAmcProposal | null> {
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/procurement/requests/extract-proposal", { method: "POST", body: fd });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.status === "ok" && json.extracted ? (json.extracted as ExtractedAmcProposal) : null;
  } catch {
    return null;
  }
}
