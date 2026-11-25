type PlacesFailure = { ok: false; status: number; code: string; error: string };
type PlacesResult<T> = { ok: true; data: T } | PlacesFailure;

const failure = (status: number, code: string, error: string): PlacesFailure => ({ ok: false, status, code, error });
const unavailable = () => failure(502, "unavailable", "Google address suggestions are temporarily unavailable.");

function placesFailure(status: number, body: { error?: { status?: string; details?: Array<{ reason?: string }> } } | null) {
  const reasons = Array.isArray(body?.error?.details) ? body.error.details.map((detail) => detail?.reason) : [];
  if (reasons.includes("BILLING_DISABLED")) return failure(503, "billing_disabled", "Billing is not enabled for the site's Google Maps project.");
  if (reasons.includes("SERVICE_DISABLED")) return failure(503, "api_disabled", "Places API (New) is not enabled for the site's Google Maps project.");
  if (reasons.some((reason) => typeof reason === "string" && /^API_KEY_.*_(?:BLOCKED|RESTRICTED)$/.test(reason))) {
    return failure(503, "key_restricted", "The Google Maps key restrictions don't allow requests from this site.");
  }
  if (status === 429 || body?.error?.status === "RESOURCE_EXHAUSTED") return failure(429, "quota", "Google address suggestions are at their request limit.");
  if (status === 401 || status === 403 || reasons.includes("API_KEY_INVALID") || reasons.includes("API_KEY_EXPIRED")) {
    return failure(503, "key_rejected", "Google did not accept the site's address lookup credentials.");
  }
  return unavailable();
}

export function placesSessionToken(input: unknown) {
  return typeof input === "string" && /^[A-Za-z0-9_-]{1,36}$/.test(input) ? input : undefined;
}

export async function fetchGooglePlaces<T>(key: string | undefined, path: string, fieldMask: string, body?: Record<string, unknown>): Promise<PlacesResult<T>> {
  const credential = key?.trim();
  if (!credential) return failure(503, "not_configured", "Google address suggestions are not connected to Pauli HQ yet.");
  const signal = AbortSignal.timeout(4500);
  try {
    const response = await fetch(`https://places.googleapis.com/v1/${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": credential, "X-Goog-FieldMask": fieldMask },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return placesFailure(response.status, payload);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? { ok: true, data: payload as T } : unavailable();
  } catch (error) {
    if (signal.aborted || error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return failure(504, "timeout", "Google took too long to reply.");
    }
    return unavailable();
  }
}
