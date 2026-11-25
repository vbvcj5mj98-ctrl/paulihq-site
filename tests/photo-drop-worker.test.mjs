import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canConfigurePhotoDrop, cleanupPhotoDrop, handlePhotoDrop, photoDropAllowed } from "../worker/photo-drop.ts";

// Node does not run the Worker runtime or expose FixedLengthStream. The queue
// SQL runs in real SQLite; the two adapters exercise stream and D1 API shape.
globalThis.FixedLengthStream ??= class {
  constructor() {
    const { readable, writable } = new TransformStream();
    this.readable = readable;
    this.writable = writable;
  }
};

const migration = readFileSync(new URL("../drizzle/0014_photo_drop.sql", import.meta.url), "utf8");
const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"; // Public sample from the age README.
const token = "unit-test-only-connector-authorization";
const origin = "https://paulihq.test";
const base = "/api/photo-drop";
const agent = `${base}/agent`;
const carson = "carsonpauli";
const jessi = "jessipauli";
// This is an API guard test vector, not a decryptable age backup.
const ciphertext = new TextEncoder().encode("age-encryption.org/v1\nciphertext-test-vector");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  t.after(() => database.close());
  const DB = {
    prepare(query) {
      const stmt = database.prepare(query);
      const withValues = (values) => ({
        bind: (...args) => withValues(args),
        first: async () => stmt.get(...values) ?? null,
        all: async () => ({ results: stmt.all(...values) }),
        run: async () => ({ meta: stmt.run(...values) }),
      });
      return withValues([]);
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const objects = new Map();
  const PHOTO_DROP_BUCKET = {
    async put(key, stream, options) {
      const contents = await new Response(stream).arrayBuffer();
      if (options.onlyIf?.get("If-None-Match") === "*" && objects.has(key)) return null;
      if (options.sha256) {
        const actual = createHash("sha256").update(new Uint8Array(contents)).digest();
        assert.deepEqual(actual, Buffer.from(options.sha256));
      }
      const object = { size: contents.byteLength, bytes: contents };
      objects.set(key, object);
      return object;
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { size: object.size, body: new Response(object.bytes).body } : null;
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
  return { database, objects, DB, PHOTO_DROP_BUCKET, PHOTO_DROP_RECIPIENT: recipient, PHOTO_DROP_AGENT_TOKEN: token };
}

function send(env, pathname = base, { username, headers, ...init } = {}) {
  return handlePhotoDrop(new Request(origin + pathname, { ...init, headers }), env, username);
}

function upload(env, { username = carson, body = ciphertext, ...headers } = {}) {
  return send(env, base, { username, method: "POST", body, headers: {
    origin,
    "content-type": "application/octet-stream",
    "content-length": String(body.length),
    "x-photo-drop-upload-id": randomUUID(),
    "x-photo-drop-sha256": hash(body),
    ...headers,
  } });
}

function connector(env, id, status) {
  const headers = { authorization: `Bearer ${token}` };
  return send(env, id ? `${agent}/${id}` : agent, status ? {
    method: "POST", body: JSON.stringify({ status }), headers: { ...headers, "content-type": "application/json" },
  } : { headers });
}

test("unconfigured guard, original allowlist, and device authentication do not leak data", async (t) => {
  const env = fixture(t);
  const malformed = { ...env, PHOTO_DROP_RECIPIENT: recipient.slice(0, -1) + "q" };
  const off = { DB: env.DB };
  assert.equal(canConfigurePhotoDrop(env), true);
  assert.equal(canConfigurePhotoDrop(malformed), false);
  assert.equal(canConfigurePhotoDrop({ ...env, PHOTO_DROP_AGENT_TOKEN: "too-short" }), false);
  assert.equal(photoDropAllowed(carson), true);
  assert.equal(photoDropAllowed(jessi), true);
  assert.equal(photoDropAllowed("Carsonpauli"), false);
  assert.equal((await send(env)).status, 401);
  assert.equal((await send(env, base, { username: "someoneelse" })).status, 403);
  assert.equal((await send(env, agent, { username: carson })).status, 401);
  assert.equal((await send(env, agent, { headers: { authorization: `Bearer ${token}x` } })).status, 401);
  assert.equal((await connector(off)).status, 401);
  assert.equal((await upload(off)).status, 503);
  assert.deepEqual(await (await send(off, base, { username: carson })).json(), { configured: false, recipient: null, items: [] });
});

test("checks browser origin, type, known size, age header, and never queues incomplete uploads", async (t) => {
  const env = fixture(t);
  assert.equal((await upload(env, { origin: "https://foreign.test" })).status, 403);
  assert.equal((await upload(env, { "content-type": "text/plain" })).status, 415);
  assert.equal((await upload(env, { "content-length": "" })).status, 411);
  assert.equal((await upload(env, { "content-length": String(26 * 1024 * 1024) })).status, 413);
  const notAge = new Uint8Array(80);
  assert.equal((await upload(env, { "x-photo-drop-sha256": "" })).status, 400);
  assert.equal((await upload(env, { "x-photo-drop-upload-id": "" })).status, 400);
  assert.equal((await upload(env, { body: notAge })).status, 400);
  assert.equal((await upload(env, { "content-length": String(ciphertext.length + 1) })).status, 400);
  assert.equal(env.objects.size, 0);
  assert.deepEqual(await (await connector(env)).json(), { items: [] });
});

test("owner-scoped status and authenticated download followed by monotonic backup acknowledgement", async (t) => {
  const env = fixture(t);
  const uploadResponse = await upload(env);
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  const id = uploaded.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(uploaded.status, "queued");
  assert.equal(uploaded.bytes, ciphertext.length);
  assert.equal(env.objects.size, 1);
  const carsonStatus = await send(env, base, { username: carson });
  assert.match(carsonStatus.headers.get("cache-control"), /no-store/);
  assert.deepEqual((await carsonStatus.json()).items, [uploaded]);
  assert.deepEqual((await (await send(env, base, { username: jessi })).json()).items, []);
  assert.deepEqual((await (await connector(env)).json()).items, [{ ...uploaded, sha256: hash(ciphertext) }]);
  const downloaded = await connector(env, id);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), ciphertext);

  assert.equal((await connector(env, id, "backed_up")).status, 409);
  assert.equal(env.objects.size, 1);
  assert.equal((await (await connector(env, id, "on_pc")).json()).status, "on_pc");
  assert.equal((await (await connector(env, id, "on_pc")).json()).status, "on_pc");
  assert.equal(env.objects.size, 1);
  assert.equal((await (await connector(env, id, "backed_up")).json()).status, "backed_up");
  assert.equal((await (await connector(env, id, "backed_up")).json()).status, "backed_up");
  assert.equal((await (await connector(env, id, "on_pc")).json()).status, "backed_up");
  assert.equal((await connector(env, id)).status, 410);
  assert.deepEqual((await (await connector(env)).json()).items, []);
  assert.equal(env.objects.size, 0);
});

test("owner-scoped retries cannot overwrite a stored upload", async (t) => {
  const env = fixture(t);
  const options = {
    "x-photo-drop-upload-id": "e017f015-c5cc-411c-adca-a28cfeb139ca",
    "x-photo-drop-sha256": hash(ciphertext),
  };
  const first = await upload(env, options);
  assert.equal(first.status, 201);
  const original = await first.json();
  const repeat = await upload(env, options);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), original);
  const conflict = await upload(env, { ...options, "x-photo-drop-sha256": "a".repeat(64) });
  assert.equal(conflict.status, 409);
  assert.equal(env.objects.size, 1);
  const other = await upload(env, { ...options, username: jessi });
  assert.equal(other.status, 201);
  assert.notEqual((await other.json()).id, original.id);
  assert.equal(env.objects.size, 2);
});

test("expired jobs can't be downloaded and scheduled cleanup clears their ciphertext", async (t) => {
  const env = fixture(t);
  const { id } = await (await upload(env)).json();
  env.database.prepare("UPDATE photo_drop_uploads SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id);
  assert.equal((await connector(env, id)).status, 410);
  assert.equal((await connector(env, id, "on_pc")).status, 410);
  assert.deepEqual((await (await connector(env)).json()).items, []);
  assert.equal((await (await send(env, base, { username: carson })).json()).items[0].status, "expired");
  assert.equal(env.objects.size, 1);
  await cleanupPhotoDrop(env);
  assert.equal(env.objects.size, 0);
  assert.equal(env.database.prepare("SELECT status FROM photo_drop_uploads WHERE id = ?").get(id).status, "expired");
  await cleanupPhotoDrop(env);
});
