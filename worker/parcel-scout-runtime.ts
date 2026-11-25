export class ScoutLookupError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ScoutDepth = "quick" | "ownership" | "valuation";

export const scoutDeadlines = { records: 5_000, quick: 15_000, deep: 24_000 };

const addressWords: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", court: "ct", boulevard: "blvd",
  lane: "ln", place: "pl", terrace: "ter", parkway: "pkwy", circle: "cir", highway: "hwy",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  apartment: "unit", apt: "unit", suite: "unit", ste: "unit",
};
const states = new Set("al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy as gu mp pr vi".split(" "));

function canonicalAddress(input: string) {
  const formatted = input.toLowerCase().trim().replace(/,?\s+(?:united states(?: of america)?|usa|us)\.?$/, "");
  const zip = formatted.match(/(?:,|\s)(\d{5})(?:-\d{4})?$/)?.[1] ?? "";
  const core = formatted.replace(/(?:,|\s)\d{5}(?:-\d{4})?$/, "").replace(/#\s*(?=[a-z0-9])/g, " unit ")
    .match(/[a-z0-9]+/g)?.map((word) => addressWords[word] ?? word).join(" ") ?? "";
  return { core, zip };
}

export function sameScoutAddress(query: string, record: string): boolean {
  const expected = canonicalAddress(query);
  const actual = canonicalAddress(record);
  // Require a jurisdictional address, not a loose street-name or ZIP match.
  const parts = actual.core.split(" ");
  return Boolean(expected.core && expected.core === actual.core && parts.length >= 4 && states.has(parts.at(-1) ?? "")
    && (!expected.zip || expected.zip === actual.zip));
}

function canonicalIdentifier(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sameScoutParcel(input: { queryType: string; queryText: string; county: string; state: string }, identity: Record<string, unknown>) {
  if (input.queryType === "address") return sameScoutAddress(input.queryText, String(identity.address ?? ""));
  const apn = canonicalIdentifier(input.queryText);
  const county = canonicalIdentifier(input.county.replace(/\s+county$/i, ""));
  return Boolean(apn && county && apn === canonicalIdentifier(identity.apn)
    && county === canonicalIdentifier(String(identity.county ?? "").replace(/\s+county$/i, ""))
    && input.state.toUpperCase() === String(identity.state ?? "").toUpperCase().trim());
}

export async function scoutProviderJson<T>(url: string, options: RequestInit, deadline: number, provider: string): Promise<{ response: Response; payload: T }> {
  const remaining = deadline - Date.now();
  const deadlineError = () => new ScoutLookupError(504, `${provider} timed out. Use the county record search, or try again later.`);
  if (remaining <= 0) throw deadlineError();
  const signal = AbortSignal.timeout(remaining);
  try {
    const response = await fetch(url, { ...options, signal });
    const payload = await response.json().catch((error) => {
      if (!response.ok && !signal.aborted) return {};
      throw error;
    }) as T;
    return { response, payload };
  } catch {
    if (signal.aborted) throw deadlineError();
    throw new ScoutLookupError(502, `${provider} did not return a usable response. Use the county record search, or try again later.`);
  }
}

export function missingScoutModel(status: number, error?: { code?: string; message?: string }) {
  return error?.code === "model_not_found" || (status === 404 && /\bmodel\b/i.test(error?.message ?? ""));
}

export function sourceKey(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}
