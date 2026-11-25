import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { sameScoutAddress, sameScoutParcel, scoutProviderJson, ScoutLookupError } from "../worker/parcel-scout-runtime.ts";

const Carson = "carsonpauli";
const Jessi = "jessipauli";
const testAddress = "123 Example Street, Testville, AR 72712, USA";
const normalizedAddress = "123 Example St, Testville, AR 72712";
const matchingRecord = { formattedAddress: normalizedAddress, assessorID: "01-002-A", county: "Example", state: "AR", bedrooms: 3, owner: { names: ["Example Family LLC"] } };

const bundledWorker = await build({
  entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
  write: false, bundle: true, format: "esm", platform: "node", target: "node22",
  plugins: [{ name: "stub-renderer", setup(plugin) {
    plugin.onResolve({ filter: /^vinext\/server\// }, (args) => ({ path: args.path, namespace: "stub-renderer" }));
    plugin.onLoad({ filter: /.*/, namespace: "stub-renderer" }, (args) => ({ contents: args.path.endsWith("image-optimization")
      ? "export const DEFAULT_DEVICE_SIZES=[],DEFAULT_IMAGE_SIZES=[]; export function handleImageOptimization(){throw new Error('Unexpected route');}"
      : "export default { fetch(){throw new Error('Unexpected route');} };" }));
  } }],
});
const workerUrl = `data:text/javascript;base64,${Buffer.from(bundledWorker.outputFiles[0].text).toString("base64")}`;

async function fixture(t, providerResponses, credentials = {}) {
  const { default: worker } = await import(`${workerUrl}#${randomUUID()}`);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const DB = {
    prepare(query) {
      const statement = () => db.prepare(query);
      const withValues = (values) => ({
        bind: (...args) => withValues(args),
        first: async () => statement().get(...values) ?? null,
        all: async () => ({ results: statement().all(...values) }),
        run: async () => ({ meta: statement().run(...values) }),
      });
      return withValues([]);
    },
    async batch(items) { return Promise.all(items.map((item) => item.run())); },
  };
  const env = { DB, ...credentials };
  assert.equal((await worker.fetch(new Request("https://unit.test/api/status"), env, {})).status, 200);
  const sessions = new Map([Carson, Jessi].map((name) => [name, randomUUID()]));
  for (const [name, token] of sessions) db.prepare("INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(token).digest("base64url"), name, Date.now() + 60_000);
  const providerCalls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    providerCalls.push({ url: String(url), options });
    const resolve = providerResponses.shift();
    assert.ok(resolve, "An unexpected upstream request was made");
    return typeof resolve === "function" ? resolve(url, options) : resolve;
  });
  async function request(query = "", { method = "GET", name = Carson, body } = {}) {
    return worker.fetch(new Request(`https://unit.test/api/property-research${query}`, { method,
      headers: { cookie: `paulihq_session=${sessions.get(name)}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }), env, {});
  }
  const lookup = (body = {}) => request("", { method: "POST", body: { queryType: "address", queryText: testAddress, ...body } });
  return { db, request, lookup, providerCalls };
}

test("record matching rejects wrong units, zip codes, and APN jurisdictions", () => {
  assert.equal(sameScoutAddress(testAddress, normalizedAddress), true);
  assert.equal(sameScoutAddress("123 Example Street, Testville, AR", normalizedAddress), true);
  assert.equal(sameScoutAddress("123 Example Street #2, Testville, AR", "123 Example St, Apt 2, Testville, AR"), true);
  assert.equal(sameScoutAddress("123 Example Street #2, Testville, AR", normalizedAddress), false);
  assert.equal(sameScoutAddress("123 Example Street, Testville, AR 72701", normalizedAddress), false);
  assert.equal(sameScoutAddress("123 Example Street", "123 Example St"), false);
  const parcel = { queryType: "apn", queryText: "01-002-A", county: "Example County", state: "AR" };
  assert.equal(sameScoutParcel(parcel, { apn: "01002A", county: "example", state: "AR" }), true);
  assert.equal(sameScoutParcel(parcel, { apn: "01002A", county: "Another", state: "AR" }), false);
});

test("provider deadline aborts outstanding requests and returns an actionable timeout", async (t) => {
  const keepAlive = setTimeout(() => {}, 100);
  t.after(() => clearTimeout(keepAlive));
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(scoutProviderJson("https://unit.test/fixture", {}, Date.now() + 10, "Test records"),
    (error) => error instanceof ScoutLookupError && error.status === 504 && /county record search/.test(error.message));
});

test("exact structured results use one request, cache and star reports, and return slim private history", async (t) => {
  const { request, lookup, providerCalls } = await fixture(t, [Response.json([matchingRecord])], { RENTCAST_API_KEY: "unit-test" });
  const response = await lookup();
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.cached, false);
  assert.equal(saved.result.ownership.owner_name, "Example Family LLC");
  assert.equal(saved.result.financial.assessed_value ?? null, null);
  assert.equal(providerCalls.length, 1);
  assert.match(providerCalls[0].url, /^https:\/\/api\.rentcast\.io\/v1\/properties\?/);

  await request("", { method: "PATCH", body: { id: saved.id, starred: true } });
  const cached = await (await lookup()).json();
  assert.equal(cached.id, saved.id);
  assert.equal(cached.cached, true);
  assert.equal(cached.starred, true);
  assert.equal(providerCalls.length, 1);

  const history = await (await request()).json();
  assert.deepEqual(history.researches.map(({ address, result }) => ({ address, result })), [{ address: normalizedAddress, result: undefined }]);
  assert.equal(history.rentCastUsage.requests, 1);
  assert.equal(history.usage.requests, 0);
  assert.equal((await request(`?id=${saved.id}`, { name: Jessi })).status, 404);
  assert.equal((await (await request(`?id=${saved.id}`)).json()).research.result.property.beds, 3);
});

test("capped RentCast and AI credential failures do not fan out or overwrite a saved report", async (t) => {
  const { db, lookup, providerCalls } = await fixture(t, [Response.json([matchingRecord]), Response.json({ error: { code: "invalid_api_key" } }, { status: 401 })], {
    RENTCAST_API_KEY: "unit-test", OPENAI_API_KEY: "unit-test", PROPERTY_RESEARCH_MODEL: "unit-test-model",
  });
  const saved = await (await lookup()).json();
  db.prepare("UPDATE api_usage SET requests=50 WHERE service='rentcast'").run();
  const refreshed = await (await lookup({ force: true })).json();
  assert.equal(refreshed.id, saved.id);
  assert.equal(refreshed.cached, true);
  assert.equal(refreshed.refreshedAt, saved.refreshedAt);
  assert.match(refreshed.notice, /invalid|Cloudflare/i);
  assert.equal(providerCalls.length, 2);
  assert.match(providerCalls[1].url, /^https:\/\/api\.openai\.com/);
  assert.equal(JSON.parse(providerCalls[1].options.body).max_tool_calls, 3);
  assert.equal(db.prepare("SELECT requests FROM api_usage WHERE service='rentcast'").get()?.requests, 50);
});

test("deep work is opt-in and rejects a mismatched or unsupported web result without destroying saved data", async (t) => {
  const source = "https://records.example.test/property/01002A";
  const unverified = Response.json({ output_text: JSON.stringify({ identity: { address: normalizedAddress }, ownership: { owner_name: "Unsupported replacement" }, sources: [{ url: source }] }), output: [] });
  const { lookup, providerCalls } = await fixture(t, [Response.json([matchingRecord]), unverified], { RENTCAST_API_KEY: "unit-test", OPENAI_API_KEY: "unit-test" });
  assert.equal((await lookup({ depth: "ownership" })).status, 404);
  assert.equal(providerCalls.length, 0);
  const saved = await (await lookup()).json();
  assert.equal(providerCalls.length, 1);
  const deep = await (await lookup({ depth: "ownership" })).json();
  assert.equal(deep.cached, true);
  assert.equal(deep.id, saved.id);
  assert.equal(deep.result.ownership.owner_name, saved.result.ownership.owner_name);
  assert.match(deep.notice, /no cited source/i);
  assert.equal(providerCalls.length, 2);
  assert.equal(JSON.parse(providerCalls[1].options.body).max_tool_calls, 5);
});

test("an APN skips address quota and accepts only a reported exact parcel with a search citation", async (t) => {
  const source = "https://records.example.test/parcels/01002A";
  const modelReport = {
    identity: { apn: "01002A", county: "Example", state: "AR", address: normalizedAddress },
    ownership: { owner_name: "Example Family LLC", ownership_confidence: "medium", evidence: [{ name: "Example Family LLC", url: source, source_kind: "assessor" }] },
    financial: { estimated_value: 123456, valuation_evidence: [{ value: null, url: source }] },
    sources: [{ title: "Assessor record", url: source }],
  };
  const { lookup, providerCalls, db } = await fixture(t, [Response.json({
    output: [
      { type: "web_search_call", action: { sources: [{ url: source }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(modelReport) }] },
    ],
  })], { RENTCAST_API_KEY: "unit-test", OPENAI_API_KEY: "unit-test" });
  const response = await lookup({ queryType: "apn", queryText: "01-002-A", county: "Example County", state: "AR" });
  assert.equal(response.status, 200);
  const report = (await response.json()).result;
  assert.equal(report.ownership.owner_name, "Example Family LLC");
  assert.equal(report.financial.estimated_value, null);
  assert.equal(providerCalls.length, 1);
  assert.match(providerCalls[0].url, /^https:\/\/api\.openai\.com/);
  assert.equal(db.prepare("SELECT requests FROM api_usage WHERE service='rentcast'").get(), undefined);
});
