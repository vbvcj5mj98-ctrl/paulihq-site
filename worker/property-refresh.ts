const dayMs = 24 * 60 * 60_000;
export const propertySnapshotLifetimeMs = 7 * dayMs;
export const propertyFeedLifetimeMs = 8 * dayMs; // one weekly interval plus scheduler grace
export const sourceSeenLifetimeMs = 14 * dayMs;
export const propertyRefreshLeaseMs = 2 * 60_000;

export type PropertyFrequency = "weekly" | "daily" | "twice_daily";

const propertyTypes = new Set(["Single Family", "Condo", "Townhouse", "Multi-Family", "Apartment", "Land"]);
const rangeKeys = [["price", "minPrice", "maxPrice"], ["bedrooms", "minBedrooms", "maxBedrooms"], ["bathrooms", "minBathrooms", "maxBathrooms"], ["lotSize", "minLotSquareFeet", "maxLotSquareFeet"], ["squareFootage", "minSquareFeet", "maxSquareFeet"]] as const;
type RangeKey = (typeof rangeKeys)[number][1 | 2];
export type PropertyFilters = Partial<{
  address: string;
  city: string;
  state: string;
  zipCode: string;
  radius: number;
  propertyTypes: string[];
}> & Partial<Record<RangeKey, number>>;

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= Number.MAX_SAFE_INTEGER ? numeric : undefined;
}

export function normalizePropertyFilters(values: PropertyFilters | Record<string, unknown>): PropertyFilters {
  const filters: PropertyFilters = {};
  for (const key of ["address", "city", "state", "zipCode"] as const) {
    if (values[key] == null || values[key] === "") continue;
    const original = values[key];
    if (typeof original !== "string" || /[\x00-\x1f]/.test(original)) throw new Error(`Enter a valid ${key === "zipCode" ? "ZIP code" : key}.`);
    const value = original.trim();
    if (!value) continue;
    if (key === "state" && !/^[a-z]{2}$/i.test(value)) throw new Error("Enter the two-letter state code.");
    if (key === "zipCode" && !/^\d{5}(?:-\d{4})?$/.test(value)) throw new Error("Enter a five-digit ZIP code.");
    if (value.length > (key === "city" ? 80 : 160)) throw new Error("The location is too long.");
    filters[key] = key === "state" ? value.toUpperCase() : key === "zipCode" ? value.slice(0, 5) : value;
  }
  if (values.radius != null) {
    const radius = numberValue(values.radius);
    if (!filters.address || radius === undefined || radius <= 0 || radius > 100) throw new Error("A radius search requires a center and a radius of up to 100 miles.");
    filters.radius = radius;
  }
  if (values.propertyTypes != null) {
    if (!Array.isArray(values.propertyTypes) || values.propertyTypes.some((value) => typeof value !== "string" || !propertyTypes.has(value))) throw new Error("Choose a supported property type. Mobile/manufactured homes are not included.");
    filters.propertyTypes = Array.from(new Set(values.propertyTypes));
  }
  for (const [, minimum, maximum] of rangeKeys) {
    for (const key of [minimum, maximum]) {
      if (values[key] == null || values[key] === "") continue;
      const value = numberValue(values[key]);
      if (value === undefined) throw new Error("Enter non-negative numeric property limits.");
      filters[key] = value;
    }
    if (filters[minimum] !== undefined && filters[maximum] !== undefined && filters[minimum] > filters[maximum]) throw new Error("The minimum cannot exceed the maximum.");
  }
  if (!filters.address && !filters.city && !filters.state && !filters.zipCode) throw new Error("Add a city, state, ZIP code, or property address.");
  return filters;
}

export const northwestArkansasFilters = normalizePropertyFilters({ address: "Bentonville, AR", radius: 40, state: "AR", propertyTypes: ["Multi-Family", "Apartment"], maxPrice: 600_000 });

export function propertyFeedParams(filters: PropertyFilters, limit: number) {
  if (filters.address && !filters.radius) return new URLSearchParams({ address: filters.address });
  const params = new URLSearchParams({ status: "Active", limit: String(limit) });
  if (filters.address && filters.radius) {
    params.set("address", filters.address);
    params.set("radius", String(filters.radius));
  } else if (filters.zipCode) params.set("zipCode", filters.zipCode);
  else {
    if (filters.city) params.set("city", filters.city);
    if (filters.state) params.set("state", filters.state);
  }
  if (filters.propertyTypes?.length) params.set("propertyType", filters.propertyTypes.join("|"));
  for (const [field, min, max] of rangeKeys) {
    if (filters[min] !== undefined || filters[max] !== undefined) params.set(field, `${filters[min] ?? "*"}:${filters[max] ?? "*"}`);
  }
  return params;
}

const addressWords: Record<string, string> = { street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd", place: "pl", apartment: "unit", apt: "unit", north: "n", south: "s", east: "e", west: "w" };
function canonicalAddress(address: string) {
  return address.toLowerCase().replace(/(\b\d{5})-\d{4}\b/g, "$1").replace(/#/g, " unit ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).map((word) => addressWords[word] ?? word).join(" ");
}

function matchesFilters(item: Record<string, unknown>, filters: PropertyFilters) {
  if (filters.state && String(item.state ?? "").trim().toUpperCase() !== filters.state) return false;
  if (filters.city && String(item.city ?? "").trim().toLowerCase() !== filters.city.toLowerCase()) return false;
  if (filters.zipCode && String(item.zipCode ?? "").trim().slice(0, 5) !== filters.zipCode) return false;
  if (filters.address && !filters.radius && canonicalAddress(String(item.formattedAddress ?? "")) !== canonicalAddress(filters.address)) return false;
  if (filters.propertyTypes?.length && !filters.propertyTypes.some((type) => type.toLowerCase() === String(item.propertyType ?? "").trim().toLowerCase())) return false;
  for (const [field, min, max] of rangeKeys) {
    if (filters[min] === undefined && filters[max] === undefined) continue;
    const value = numberValue(item[field]);
    if (value === undefined || (filters[min] !== undefined && value < filters[min]) || (filters[max] !== undefined && value > filters[max])) return false;
  }
  return true;
}

export function propertyFrequency(value: unknown): PropertyFrequency {
  return value === "daily" || value === "twice_daily" ? value : "weekly";
}

export function propertyRefreshInterval(value: unknown) {
  return propertyFrequency(value) === "twice_daily" ? dayMs / 2 : propertyFrequency(value) === "daily" ? dayMs : propertySnapshotLifetimeMs;
}

export function nextPropertyRefresh(frequency: unknown, lastSyncedAt: number | null, lastAttemptAt: number | null, lastAttemptStatus: string | null, now: number) {
  const interval = propertyRefreshInterval(frequency);
  if (lastAttemptAt != null && lastAttemptStatus === "quota_reached" && new Date(lastAttemptAt).toISOString().slice(0, 7) === new Date(now).toISOString().slice(0, 7)) {
    return Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
  }
  const last = Math.max(lastSyncedAt ?? 0, lastAttemptStatus === "quota_reached" ? 0 : lastAttemptAt ?? 0);
  return last ? last + interval : null;
}

export function activePropertyCandidates(payload: unknown, limit: number, mode: string, now: number, constraints: PropertyFilters = {}) {
  if (!Array.isArray(payload)) throw new Error("Property feed returned an invalid result.");
  // A malformed 200 response is not an empty successful snapshot.
  if (payload.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.formattedAddress !== "string" || !item.formattedAddress.trim() || !["active", "inactive"].includes(String(item.status).trim().toLowerCase()))) throw new Error("Property feed returned invalid listings.");
  const result: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of payload.slice(0, limit)) {
    if (String(item.status).trim().toLowerCase() !== "active") continue;
    const sourceSeen = typeof item.lastSeenDate === "string" ? Date.parse(item.lastSeenDate) : NaN;
    if (Number.isFinite(sourceSeen) && sourceSeen < now - sourceSeenLifetimeMs) continue;
    const propertyType = String(item.propertyType ?? "").toLowerCase();
    if (propertyType.includes("mobile") || propertyType.includes("manufactured")) continue;
    if (mode === "income" && Number(item.hoa?.fee ?? 0) > 0) continue;
    if (!matchesFilters(item, constraints)) continue;
    const id = item.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

// The caller assigns aliases `l` to the listing and `s` to its search.
// last_seen_at is local snapshot membership, not RentCast's lastSeenDate.
const sqliteNow = "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)";
const listingJson = "(CASE WHEN json_valid(l.raw_json) THEN l.raw_json ELSE '{}' END)";
const sourceSeen = `(CAST(strftime('%s', json_extract(${listingJson}, '$.lastSeenDate')) AS INTEGER) * 1000)`;
export const propertyAvailabilitySql = `CASE
  WHEN lower(trim(COALESCE(l.status, ''))) != 'active' THEN 'not_in_latest'
  WHEN s.last_synced_at IS NOT NULL AND l.last_seen_at != s.last_synced_at THEN 'not_in_latest'
  WHEN s.source_filters IS NULL AND s.active = 0 THEN 'not_in_latest'
  WHEN s.id = -100 AND (COALESCE(upper(trim(l.state)), '') != 'AR' OR COALESCE(lower(trim(l.property_type)), '') NOT IN ('multi-family', 'apartment') OR l.price IS NULL OR l.price > 600000) THEN 'not_in_latest'
  WHEN s.id != -100 AND s.source_filters IS NULL AND (
    (s.state IS NOT NULL AND COALESCE(upper(trim(l.state)), '') != upper(trim(s.state)))
    OR (s.city IS NOT NULL AND COALESCE(lower(trim(l.city)), '') != lower(trim(s.city)))
    OR (s.zip_code IS NOT NULL AND COALESCE(substr(trim(l.zip_code), 1, 5), '') != substr(trim(s.zip_code), 1, 5))
    OR (s.min_price IS NOT NULL AND (l.price IS NULL OR l.price < s.min_price))
    OR (s.max_price IS NOT NULL AND (l.price IS NULL OR l.price > s.max_price))
  ) THEN 'not_in_latest'
  WHEN l.last_seen_at < ${sqliteNow} - CASE WHEN s.active = 1 THEN ${propertyFeedLifetimeMs} ELSE ${propertySnapshotLifetimeMs} END THEN 'stale'
  WHEN ${sourceSeen} < ${sqliteNow} - ${sourceSeenLifetimeMs} THEN 'stale'
  ELSE 'active' END`;
