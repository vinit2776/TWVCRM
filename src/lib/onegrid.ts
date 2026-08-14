// Server-only client for the OneGrid Telemetry Data API.
// https://187.127.138.165:8000/api/v1 — org-scoped API key, two read-only endpoints.
const ONEGRID_BASE_URL =
  process.env.ONEGRID_BASE_URL || "http://187.127.138.165:8000/api/v1";

export interface OnegridDeviceSummary {
  device_id: string;
  device_label: string;
  meter_role: "main" | "sub" | string;
}

export interface OnegridDevicesResponse {
  org_id: string;
  devices: string[];
  count: number;
  no_telemetry_yet: string[];
  by_plant: Record<
    string,
    { plant_name: string; devices: OnegridDeviceSummary[] }
  >;
}

export interface OnegridTelemetryResponse {
  device_id: string;
  measurement: string;
  range: { start: string; end: string };
  tz: string;
  every: string;
  agg: string;
  format: string;
  derive: string | null;
  fields: string[];
  filters: { hour: number | null; minute: number | null };
  estimated_points: number;
  n_points: number;
  truncated: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  series: Record<string, any>[];
}

export class OnegridApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function onegridRequest<T>(path: string, apiKey: string, searchParams?: URLSearchParams): Promise<T> {
  const url = `${ONEGRID_BASE_URL}${path}${searchParams && searchParams.size > 0 ? `?${searchParams}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OnegridApiError(502, "NETWORK_ERROR", "Could not reach the OneGrid telemetry service");
  }

  if (!res.ok) {
    let code = "UNKNOWN_ERROR";
    let message = `OneGrid request failed with status ${res.status}`;
    try {
      const json = await res.json();
      code = json?.detail?.code ?? code;
      message = json?.detail?.message ?? message;
    } catch {
      // response body wasn't JSON — fall back to defaults above
    }
    throw new OnegridApiError(res.status, code, message);
  }

  return res.json() as Promise<T>;
}

export function fetchOnegridDevices(apiKey: string) {
  return onegridRequest<OnegridDevicesResponse>("/telemetry/devices", apiKey);
}

export function fetchOnegridTelemetry(
  apiKey: string,
  deviceId: string,
  params: Record<string, string | undefined>
) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") searchParams.set(key, value);
  }
  return onegridRequest<OnegridTelemetryResponse>(
    `/telemetry/device/${encodeURIComponent(deviceId)}`,
    apiKey,
    searchParams
  );
}
