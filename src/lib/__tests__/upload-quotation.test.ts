import { describe, it, expect, vi } from "vitest";
import { uploadQuotation, type QuotationUploadDeps } from "../procurement/upload-quotation";

const file = new File(["%PDF"], "proposal.pdf", { type: "application/pdf" });
const q = { file, vendor_name: " Blue Star ", amount: "41400", notes: " AMC proposal " };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function deps(over: Partial<QuotationUploadDeps> = {}) {
  const fetchJson = vi.fn<QuotationUploadDeps["fetchJson"]>()
    .mockResolvedValueOnce(json(200, { token: "tok", path: "material-requests/pr1/abc.pdf" }))
    .mockResolvedValueOnce(json(201, { data: {} }));
  const d: QuotationUploadDeps = { fetchJson, uploadToSignedUrl: vi.fn().mockResolvedValue(null), prepare: vi.fn(async (f: File) => f), ...over };
  return { d, fetchJson };
}

describe("uploadQuotation", () => {
  it("uploads to storage first, then sends the route JSON details (not the file)", async () => {
    const { d, fetchJson } = deps();
    expect(await uploadQuotation("pr1", q, d)).toEqual({ ok: true });
    expect(JSON.parse(fetchJson.mock.calls[0][1]!.body as string)).toEqual({ fileName: "proposal.pdf", mimeType: "application/pdf", path: "material-requests/pr1" });
    expect(d.uploadToSignedUrl).toHaveBeenCalledWith("material-requests/pr1/abc.pdf", "tok", file);
    const [url, init] = fetchJson.mock.calls[1];
    expect(url).toBe("/api/procurement/requests/pr1/quotations");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init!.body as string)).toEqual({
      filePath: "material-requests/pr1/abc.pdf", fileName: "proposal.pdf", mimeType: "application/pdf",
      vendor_name: "Blue Star", amount: "41400", notes: "AMC proposal",
    });
  });
  it("reports the route's error and does not throw", async () => {
    const fetchJson = vi.fn<QuotationUploadDeps["fetchJson"]>()
      .mockResolvedValueOnce(json(200, { token: "t", path: "p" }))
      .mockResolvedValueOnce(json(422, { error: "Quotations can only be added before approval" }));
    const { d } = deps({ fetchJson });
    expect(await uploadQuotation("pr1", q, d)).toEqual({ ok: false, error: "Quotations can only be added before approval" });
  });
  it("stops with a message when no upload URL can be had, or storage refuses", async () => {
    const noUrl = deps({ fetchJson: vi.fn().mockResolvedValue(json(500, {})) });
    expect(await uploadQuotation("pr1", q, noUrl.d)).toEqual({ ok: false, error: "Failed to get upload URL" });
    const storage = deps({ uploadToSignedUrl: vi.fn().mockResolvedValue("Bucket not found") });
    expect(await uploadQuotation("pr1", q, storage.d)).toEqual({ ok: false, error: "Bucket not found" });
    expect(storage.fetchJson).toHaveBeenCalledTimes(1);
  });
  it("stops quietly when the user declines a large file, and turns thrown errors into messages", async () => {
    expect(await uploadQuotation("pr1", q, deps({ prepare: vi.fn().mockResolvedValue(null) }).d)).toEqual({ ok: false, error: "Upload cancelled" });
    expect(await uploadQuotation("pr1", q, deps({ prepare: vi.fn().mockRejectedValue(new Error("File too large (60.0 MB).")) }).d)).toEqual({ ok: false, error: "File too large (60.0 MB)." });
  });
});
