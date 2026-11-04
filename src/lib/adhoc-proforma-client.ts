/** Fetches the ad-hoc proforma PDF (same layout as Receivables) as a Blob. */
export async function fetchAdhocProformaPdf(invoiceId: string): Promise<Blob> {
  const res = await fetch(`/api/invoices/${invoiceId}/proforma-pdf`);
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error || "Failed to generate the proforma PDF");
  }
  return res.blob();
}

export async function downloadAdhocProformaPdf(invoiceId: string, invoiceNumber: string | null) {
  const url = URL.createObjectURL(await fetchAdhocProformaPdf(invoiceId));
  const a = document.createElement("a");
  a.href = url;
  a.download = `Proforma-${invoiceNumber ?? invoiceId}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Base64 body of the PDF, the shape EmailDocumentDialog's onGeneratePDF expects. */
export async function adhocProformaPdfBase64(invoiceId: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetchAdhocProformaPdf(invoiceId)).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
