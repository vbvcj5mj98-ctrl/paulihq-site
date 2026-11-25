import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
  write: false, bundle: true, format: "esm", platform: "node", target: "node22",
  plugins: [{ name: "stub-renderer", setup(plugin) {
    plugin.onResolve({ filter: /^vinext\/server\// }, ({ path }) => ({ path, namespace: "stub-renderer" }));
    plugin.onLoad({ filter: /.*/, namespace: "stub-renderer" }, ({ path }) => ({
      contents: path.endsWith("image-optimization")
        ? "export const DEFAULT_DEVICE_SIZES=[],DEFAULT_IMAGE_SIZES=[]; export function handleImageOptimization(){throw new Error('Unexpected route');}"
        : "export default { fetch(){throw new Error('Unexpected route');} };",
    }));
  } }],
});
const workerUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`;
const apiKey = "fixture-maps-key-not-a-secret";
const rawProviderText = `provider message must not be returned: ${apiKey}`;
const suggestionUrl = "/api/address-autocomplete";
const detailsUrl = "/api/address-details";

async function fixture(t, responses = [], credentials = {}) {
  const { default: worker } = await import(`${workerUrl}#${randomUUID()}`);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const DB = {
    prepare(sql) {
      const statement = () => db.prepare(sql);
      const bind = (...values) => ({
        bind,
        first: async () => statement().get(...values) ?? null,
        all: async () => ({ results: statement().all(...values) }),
        run: async () => ({ meta: statement().run(...values) }),
      });
      return bind();
    },
    async batch(items) { return Promise.all(items.map((item) => item.run())); },
  };
  const pending = [...responses];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: new URL(url), init, headers: new Headers(init?.headers) });
    assert.ok(pending.length, "Unexpected provider call");
    const next = pending.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const env = { DB, ...credentials };
  const origin = "https://unit.test";
  assert.equal((await worker.fetch(new Request(`${origin}/api/status`), env, {})).status, 200);
  const token = randomUUID();
  db.prepare("INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, 'carsonpauli', ?)")
    .run(createHash("sha256").update(token).digest("base64url"), Date.now() + 60_000);
  const request = (path, body, { method = "POST", signedIn = true } = {}) => worker.fetch(new Request(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(signedIn ? { cookie: `paulihq_session=${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {});
  return { calls, request };
}

async function verifiedError(response, status, code) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.equal(payload.code, code);
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length > 0);
  assert.doesNotMatch(JSON.stringify(payload), /fixture-maps-key|provider message must not be returned|google\.rpc\.ErrorInfo/);
}

test("address lookup requires a session and does not bill short input or missing configuration", async (t) => {
  const { request, calls } = await fixture(t);
  assert.equal((await request(suggestionUrl, { input: "123 Example St" }, { signedIn: false })).status, 401);
  assert.equal((await request(detailsUrl, { placeId: "example" }, { signedIn: false })).status, 401);
  assert.equal((await request(suggestionUrl, undefined, { method: "GET" })).status, 405);
  const short = await request(suggestionUrl, { input: " 123 " });
  assert.equal(short.status, 200);
  assert.deepEqual(await short.json(), { suggestions: [] });
  await verifiedError(await request(suggestionUrl, { input: "123 Example St" }), 503, "not_configured");
  await verifiedError(await request(detailsUrl, { placeId: "example" }), 503, "not_configured");
  assert.equal(calls.length, 0);
});

test("address suggestions and selection retain the Places session and return only the fields each form needs", async (t) => {
  const placeId = "example/place";
  const address = "123 Example St, Bentonville, AR 72712";
  const sessionToken = randomUUID();
  const { request, calls } = await fixture(t, [
    Response.json({ suggestions: [{ placePrediction: { placeId, text: { text: `${address}, USA` } } }, { queryPrediction: { text: { text: "not an address" } } }] }),
    Response.json({ formattedAddress: `${address}, USA`, location: { latitude: 36.37, longitude: -94.21 } }),
  ], { GOOGLE_MAPS_API_KEY: apiKey });
  const suggestions = await request(suggestionUrl, { input: " 123 Example ", sessionToken });
  assert.equal(suggestions.status, 200);
  assert.deepEqual(await suggestions.json(), { suggestions: [{ placeId, text: `${address}, USA` }] });
  assert.equal(calls.length, 1, "Suggestions alone do not look up address details or property value");
  assert.equal(calls[0].url.href, "https://places.googleapis.com/v1/places:autocomplete");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].headers.get("X-Goog-Api-Key"), apiKey);
  const suggestBody = JSON.parse(calls[0].init.body);
  assert.equal(suggestBody.input, "123 Example");
  assert.equal(suggestBody.sessionToken, sessionToken);
  assert.deepEqual(suggestBody.includedRegionCodes, ["us"]);

  const details = await request(detailsUrl, { placeId, sessionToken });
  assert.equal(details.status, 200);
  assert.deepEqual(await details.json(), { address, latitude: 36.37, longitude: -94.21 });
  assert.equal(calls.length, 2, "Details never sends RentCast a valuation request");
  assert.equal(calls[1].url.origin, "https://places.googleapis.com");
  assert.equal(calls[1].url.pathname, "/v1/places/example%2Fplace");
  assert.equal(calls[1].url.searchParams.get("sessionToken"), sessionToken);
  assert.equal(calls[1].headers.get("X-Goog-Api-Key"), apiKey);
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.doesNotMatch(call.url.href, /fixture-maps-key/);
  }
});

function providerError(status, reason) {
  return Response.json({
    error: {
      code: status,
      status: status === 429 ? "RESOURCE_EXHAUSTED" : "PERMISSION_DENIED",
      message: rawProviderText,
      details: reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] : [],
    },
  }, { status });
}

test("address endpoints turn rejected Places configuration, quota, and timeout into safe, distinct errors", async (t) => {
  const { request, calls } = await fixture(t, [
    providerError(403, "API_KEY_HTTP_REFERRER_BLOCKED"),
    providerError(403, "SERVICE_DISABLED"),
    providerError(429),
    new DOMException(rawProviderText, "TimeoutError"),
  ], { GOOGLE_MAPS_API_KEY: apiKey });
  const suggest = () => request(suggestionUrl, { input: "123 Example St" });
  await verifiedError(await suggest(), 503, "key_restricted");
  await verifiedError(await request(detailsUrl, { placeId: "example" }), 503, "api_disabled");
  await verifiedError(await suggest(), 429, "quota");
  await verifiedError(await suggest(), 504, "timeout");
  assert.equal(calls.length, 4, "No provider failure caused a retry or a fallback provider call");
});
