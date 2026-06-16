// Lightweight global event bus for approval-state changes.
// Fired by any UI that mutates a vendor bill's approval_status or an
// approval_request's status, so the header bell (and any other listener)
// can refetch instead of polling.

const EVENT_NAME = "approval:changed";

export function emitApprovalChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function onApprovalChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
