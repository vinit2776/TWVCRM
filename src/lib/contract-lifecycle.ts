import { createAdminClient } from "@/lib/supabase/server";
import { revokeUnifiVoucher } from "@/lib/unifi";
import { setUserActive } from "@/lib/cosec";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Revokes WiFi vouchers (UniFi live-API + import-based) and blocks COSEC
 * building-access accounts for one contract. Mirrors the per-contract steps
 * in /api/cron/contract-expiry, extracted so any code path that expires a
 * contract outside that nightly cron (e.g. cancelling a renewal whose parent
 * term has already lapsed) can reuse the same revocation logic instead of
 * re-deriving it. All failures are logged and swallowed — the caller's
 * status change must never be blocked by a downstream device being offline.
 */
export async function revokeContractAccess(
  admin: AdminClient,
  contract: { id: string; contract_number: string; unifi_voucher_id?: string | null }
): Promise<void> {
  if (contract.unifi_voucher_id) {
    revokeUnifiVoucher(contract.unifi_voucher_id).catch((err) =>
      console.error(`[contract-lifecycle] UniFi revoke failed for ${contract.contract_number}:`, err)
    );
  }

  try {
    const { data: issuances } = await admin
      .from("voucher_issuances")
      .select("id, voucher_id")
      .eq("contract_id", contract.id)
      .eq("is_active", true);

    if (issuances && issuances.length > 0) {
      const revokeNow = new Date().toISOString();
      const issuanceIds = issuances.map((i) => i.id);
      await admin
        .from("voucher_issuances")
        .update({ is_active: false, revoked_at: revokeNow, revoke_reason: "Contract expired" })
        .in("id", issuanceIds);

      const voucherIds = issuances.map((i) => i.voucher_id).filter(Boolean);
      if (voucherIds.length > 0) {
        await admin.from("voucher_repository").update({ status: "revoked" }).in("id", voucherIds as string[]);
      }
    }
  } catch (err) {
    console.error(`[contract-lifecycle] import voucher revoke failed for ${contract.contract_number}:`, err);
  }

  try {
    const { data: memberIds } = await admin
      .from("contract_members")
      .select("id")
      .eq("contract_id", contract.id);

    if (memberIds && memberIds.length > 0) {
      const { data: accessUsers } = await admin
        .from("cosec_access_users")
        .select("id, cosec_user_id, device_id")
        .in("entity_id", memberIds.map((m) => m.id))
        .not("enrollment_status", "in", "(blocked,deleted)");

      if (accessUsers && accessUsers.length > 0) {
        const { data: deviceRows } = await admin
          .from("cosec_devices")
          .select("id, device_ip, device_port, device_password")
          .in("id", accessUsers.map((a) => a.device_id));
        const devMap = new Map((deviceRows ?? []).map((d) => [d.id, d]));
        const nowStr = new Date().toISOString();

        await Promise.allSettled(accessUsers.map(async (au) => {
          const dev = devMap.get(au.device_id);
          if (dev) {
            try {
              await setUserActive(
                { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
                au.cosec_user_id,
                false
              );
            } catch { /* device may be offline — DB update still proceeds */ }
          }
          await admin.from("cosec_access_users")
            .update({ enrollment_status: "blocked", blocked_at: nowStr, updated_at: nowStr })
            .eq("id", au.id);
        }));
      }
    }
  } catch (err) {
    console.error(`[contract-lifecycle] COSEC revocation failed for ${contract.contract_number}:`, err);
  }
}
