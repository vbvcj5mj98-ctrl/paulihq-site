const listingHosts = ["zillow.com", "redfin.com", "realtor.com", "homes.com", "trulia.com", "compass.com", "coldwellbankerhomes.com", "kw.com", "loopnet.com", "crexi.com"];
const mediaHosts = [...listingHosts, "zillowstatic.com", "cdn-redfin.com", "rdcpix.com", "trulia-cdn.com"];
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

function allowedUrl(value: string, hosts: string[], base?: URL): URL | null {
  if (!value.trim()) return null;
  try {
    const result = new URL(value, base);
    if (result.protocol !== "https:" || result.username || result.password || result.port ||
      !hosts.some((host) => result.hostname === host || result.hostname.endsWith(`.${host}`))) return null;
    result.hash = "";
    return result;
  } catch { return null; }
}

export const listingPageUrl = (value: string, base?: URL) => allowedUrl(value, listingHosts, base);
export const listingImageUrl = (value: string, base?: URL) => allowedUrl(value, mediaHosts, base);

export async function fetchListingResource(url: URL, parse: (value: string, base?: URL) => URL | null, signal: AbortSignal, accept: string, referrer?: string) {
  let next = parse(url.href);
  for (let hop = 0; next && hop <= 2; hop++) {
    const headers = new Headers({ accept });
    if (referrer) headers.set("referer", referrer);
    const response = await fetch(next, { headers, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: next };
    const location = response.headers.get("location");
    void response.body?.cancel().catch(() => undefined);
    next = location ? parse(location, next) : null;
  }
  return null;
}

export async function readListingBytes(response: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > max) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (!total) return null;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}

export function missingPhoto() {
  return new Response(null, { status: 204, headers: { "cache-control": "private, max-age=120", vary: "Cookie", "x-content-type-options": "nosniff" } });
}

export async function listingThumbnail(image: string, source: string): Promise<Response> {
  const url = listingImageUrl(image);
  if (!url) return missingPhoto();
  try {
    const site = listingPageUrl(source);
    const resource = await fetchListingResource(url, listingImageUrl, AbortSignal.timeout(4500), "image/avif,image/webp,image/png,image/jpeg,image/gif", site ? `${site.origin}/` : undefined);
    const response = resource?.response;
    const type = response?.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!response?.ok || !imageTypes.has(type)) {
      void response?.body?.cancel().catch(() => undefined);
      return missingPhoto();
    }
    const bytes = await readListingBytes(response, 5 * 1024 * 1024);
    return bytes ? new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=3600", vary: "Cookie", "x-content-type-options": "nosniff" } }) : missingPhoto();
  } catch { return missingPhoto(); }
}
