import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundledWorker = await build({
  entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
  write: false, bundle: true, platform: "node", format: "esm", target: "node22",
  plugins: [{ name: "stub-renderer", setup(plugin) {
    plugin.onResolve({ filter: /^vinext\/server\// }, (args) => ({ path: args.path, namespace: "stub-renderer" }));
    plugin.onLoad({ filter: /.*/, namespace: "stub-renderer" }, (args) => ({ contents: args.path.endsWith("image-optimization")
      ? "export const DEFAULT_DEVICE_SIZES=[],DEFAULT_IMAGE_SIZES=[]; export function handleImageOptimization(){throw new Error('Unexpected route');}"
      : "export default { fetch(){throw new Error('Unexpected route');} };" }));
  } }],
});
const workerUrl = `data:text/javascript;base64,${Buffer.from(bundledWorker.outputFiles[0].text).toString("base64")}`;

async function fixture(t, responses) {
  const { default: worker } = await import(`${workerUrl}#${randomUUID()}`);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const DB = {
    prepare(query) {
      const withValues = (values) => ({
        bind: (...args) => withValues(args),
        first: async () => db.prepare(query).get(...values) ?? null,
        all: async () => ({ results: db.prepare(query).all(...values) }),
        run: () => { const result = db.prepare(query).run(...values); return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; },
      });
      return withValues([]);
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const result = statements.map((statement) => statement.run()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const env = { DB, RENTCAST_API_KEY: "fixture-not-a-secret" };
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  assert.equal((await worker.fetch(new Request("https://property.test/api/status"), env, ctx)).status, 200);
  const sessions = new Map(["carsonpauli", "jessipauli"].map((username) => [username, randomUUID()]));
  for (const [username, token] of sessions) db.prepare("INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(token).digest("base64url"), username, Date.now() + 60_000);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(new URL(url));
    assert.ok(responses.length, "Unexpected provider call");
    return responses.shift();
  });
  const request = (route, body, username = "carsonpauli") => worker.fetch(new Request(`https://property.test${route}`, {
    method: body ? "POST" : "GET", headers: { cookie: `paulihq_session=${sessions.get(username)}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  const cron = async () => { await worker.scheduled({}, env, ctx); await Promise.all(pending.splice(0)); };
  return { db, request, cron, calls };
}

const rentcastListing = (id, state = "AR") => ({ id, formattedAddress: `100 ${id} Lane, Bentonville, ${state} 72712`, city: "Bentonville", state,
  zipCode: "72712", propertyType: "Multi-Family", price: 450_000, bedrooms: 3, bathrooms: 2, status: "Active", lastSeenDate: new Date().toISOString(), latitude: 36.3, longitude: -94.1 });
const period = new Date().toISOString().slice(0, 7);
const all = "/api/properties?mode=income&searchId=-100";
const sync = "/api/properties/sync";

test("manual refresh is owner-only, replaces the live snapshot, preserves stars and stops at 50", async (t) => {
  const { db, request, calls } = await fixture(t, [Response.json([rentcastListing("New"), rentcastListing("WrongState", "MO")])]);
  const at = Date.now() - 60_000;
  db.prepare("UPDATE property_searches SET last_synced_at = ? WHERE id = -100").run(at);
  db.prepare("INSERT INTO property_listings (source_id, search_id, mode, address, city, state, zip_code, property_type, price, status, raw_json, first_seen_at, last_seen_at) VALUES ('Old', -100, 'income', '123 Old Lane, Bentonville, AR 72712', 'Bentonville', 'AR', '72712', 'Multi-Family', 450000, 'Active', '{}', ?, ?)").run(at, at);
  assert.equal((await request("/api/property-favorites", { sourceId: "Old", searchId: -100, favorite: true })).status, 200);
  db.prepare("INSERT INTO api_usage VALUES ('rentcast', ?, 49, ?)").run(period, at);
  assert.equal((await request(sync, { searchId: -100 }, "jessipauli")).status, 403);
  assert.equal(calls.length, 0);
  const scanned = await request(sync, { searchId: -100 });
  assert.equal(scanned.status, 200);
  assert.equal((await scanned.json()).count, 1);
  assert.equal(calls[0].searchParams.get("status"), "Active");
  const live = await (await request(all)).json();
  assert.equal(live.usage.requests, 50);
  assert.deepEqual(live.listings.map((item) => item.source_id), ["New"]);
  const starred = await (await request(`${all}&starred=1`)).json();
  assert.equal(starred.listings[0].availability, "not_in_latest");
  assert.equal((await request(sync, { searchId: -100 })).status, 429);
  assert.equal(calls.length, 1);
});

test("scheduled scan waits for the weekly cadence and treats a successful empty feed as current", async (t) => {
  const { db, request, cron, calls } = await fixture(t, [Response.json([rentcastListing("First")]), Response.json([])]);
  await cron();
  assert.equal(calls.length, 1);
  assert.equal((await (await request(all)).json()).listings.length, 1);
  await cron();
  assert.equal(calls.length, 1);
  const old = Date.now() - 8 * 24 * 60 * 60_000;
  db.prepare("UPDATE property_searches SET last_synced_at = ? WHERE id = -100").run(old);
  db.prepare("UPDATE property_search_refresh SET last_attempt_at = ? WHERE search_id = -100").run(old);
  await cron();
  assert.equal(calls.length, 2);
  assert.deepEqual((await (await request(all)).json()).listings, []);
  const searches = await (await request("/api/property-searches")).json();
  assert.equal(searches.searches[0].refresh_status, "current");
  assert.equal(searches.searches[0].refresh_frequency, "weekly");
});
