import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { readConfig, runOnce, verifyEnvelope } from "../scripts/photo-drop-bridge.mjs";

const ID = "a116bc90-2817-477f-8648-70204e895566";
const TOKEN = "nottheactualtoken000000000000000000000000";
const ciphertext = Buffer.from("fixture ciphertext; mock verification only");
const fullDigest = createHash("sha256").update(ciphertext).digest("hex");

function plaintextEnvelope(bytes, size = bytes.length) {
  const metadata = Buffer.from(JSON.stringify({ name: "照片.heic", type: "image/heic", size }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(metadata.length);
  return Buffer.concat([header, metadata, bytes]);
}

function inChunks(bytes) {
  return Readable.from([...bytes].map((n) => Buffer.from([n])));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paulihq-photo-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = {
    origin: "https://paulihq.test", token: TOKEN, platform: process.platform,
    inbox: path.join(root, "inbox"), nas: path.join(root, "nas"), identity: path.join(root, "identity.txt"),
  };
  await Promise.all([mkdir(config.inbox), mkdir(config.nas), writeFile(config.identity, "fake identity")]);
  return config;
}

function mockQueue({ bytes = ciphertext.length, id = ID, responseBody = ciphertext, status = "queued" } = {}) {
  const statuses = [];
  let downloads = 0;
  const fetcher = async (url, request) => {
    assert.equal(url.origin, "https://paulihq.test");
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.redirect, "error");
    if (url.pathname === "/api/photo-drop/agent") return Response.json({ items: [{ id, bytes, status, sha256: fullDigest, createdAt: 1, expiresAt: 2 }] });
    assert.equal(url.pathname, `/api/photo-drop/agent/${id}`);
    if (request.method === "POST") {
      status = JSON.parse(request.body).status;
      statuses.push(status);
      return new Response(null, { status: 204 });
    }
    downloads++;
    return new Response(responseBody);
  };
  return { fetcher, statuses, downloads: () => downloads };
}

async function verifyFixture(filename, bytes) {
  assert.equal(bytes, ciphertext.length);
  assert.deepEqual(await readFile(filename), ciphertext);
}

test("Windows configuration separates local storage and UNC NAS without accepting traversal", () => {
  const env = {
    PAULI_PHOTO_DROP_ORIGIN: "https://paulihq.com", PAULI_PHOTO_DROP_AGENT_TOKEN: TOKEN,
    PAULI_PHOTO_DROP_INBOX: "C:\\Photo Drop", PAULI_PHOTO_DROP_NAS: "\\\\nas.example\\backups\\photo-drop",
    PAULI_PHOTO_DROP_AGE_IDENTITY: "C:\\Keys\\photo.txt",
  };
  assert.equal(readConfig(env, "win32").nas, env.PAULI_PHOTO_DROP_NAS);
  for (const [key, value] of [
    ["ORIGIN", "http://paulihq.com"], ["ORIGIN", "https://u:p@paulihq.com"], ["ORIGIN", "https://paulihq.com/subpage"],
    ["NAS", "C:\\Photo Drop"], ["NAS", "\\\\?\\UNC\\server\\share"], ["INBOX", "C:\\"],
    ["INBOX", "C:\\drop\\..\\somewhere"], ["INBOX", "C:\\drop:alternateStream"], ["AGE_IDENTITY", "\\\\nas\\share\\key.txt"],
  ]) assert.throws(() => readConfig({ ...env, [`PAULI_PHOTO_DROP_${key}`]: value }, "win32"));
});

test("authenticity pipeline understands a split envelope and rejects truncation or mismatched length", async () => {
  const image = Buffer.from([1, 2, 3]);
  const valid = plaintextEnvelope(image);
  await verifyEnvelope(inChunks(valid), 100);
  await assert.rejects(verifyEnvelope(inChunks(valid.subarray(0, -1)), 100), /incomplete/);
  await assert.rejects(verifyEnvelope(inChunks(plaintextEnvelope(image, 2)), 100), /does not match/);
  const badLength = Buffer.from(valid);
  badLength.writeUInt32BE(4097);
  await assert.rejects(verifyEnvelope(inChunks(badLength), 100), /Invalid encrypted file envelope/);
});

test("stores and verifies ciphertext at both destinations, then acknowledges backup", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue();
  const summary = await runOnce(config, { fetcher: remote.fetcher, verify: verifyFixture, resolveNas: async () => config.nas });
  assert.deepEqual(summary, { received: 1, backedUp: 1, failed: 0 });
  assert.deepEqual(remote.statuses, ["on_pc", "backed_up"]);
  assert.deepEqual(await readdir(config.inbox), [`${ID}.age`]);
  assert.deepEqual(await readdir(config.nas), [`${ID}.age`]);
  assert.deepEqual(await readFile(path.join(config.nas, `${ID}.age`)), ciphertext);
});

test("retains the PC file while NAS is offline and retries without downloading twice", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue();
  const options = { fetcher: remote.fetcher, verify: verifyFixture };
  assert.deepEqual(await runOnce(config, { ...options, resolveNas: async () => { throw new Error("offline"); } }), { received: 1, backedUp: 0, failed: 1 });
  assert.deepEqual(remote.statuses, ["on_pc"]);
  assert.equal(remote.downloads(), 1);
  assert.deepEqual(await runOnce(config, { ...options, resolveNas: async () => config.nas }), { received: 1, backedUp: 1, failed: 0 });
  assert.deepEqual(remote.statuses, ["on_pc", "backed_up"]);
  assert.equal(remote.downloads(), 1);
});

test("refuses to overwrite a conflicting NAS file or report it backed up", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue();
  const existing = Buffer.alloc(ciphertext.length, 4);
  await writeFile(path.join(config.nas, `${ID}.age`), existing);
  const summary = await runOnce(config, { fetcher: remote.fetcher, verify: verifyFixture, resolveNas: async () => config.nas });
  assert.deepEqual(summary, { received: 1, backedUp: 0, failed: 1 });
  assert.deepEqual(remote.statuses, ["on_pc"]);
  assert.deepEqual(await readFile(path.join(config.nas, `${ID}.age`)), existing);
});

test("uses a verified exclusive copy when the NAS refuses hard links", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue();
  const summary = await runOnce(config, {
    fetcher: remote.fetcher, verify: verifyFixture, resolveNas: async () => config.nas,
    linkNas: async () => { const error = new Error("hard links unavailable"); error.code = "ENOTSUP"; throw error; },
  });
  assert.deepEqual(summary, { received: 1, backedUp: 1, failed: 0 });
  assert.deepEqual(await readdir(config.nas), [`${ID}.age`]);
  assert.deepEqual(await readFile(path.join(config.nas, `${ID}.age`)), ciphertext);
  assert.deepEqual(remote.statuses, ["on_pc", "backed_up"]);
});

test("keeps an incomplete NAS file untouched and tells the operator how to recover", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue();
  const final = path.join(config.nas, `${ID}.age`);
  const partial = ciphertext.subarray(0, 3);
  const logs = [];
  const summary = await runOnce(config, {
    fetcher: remote.fetcher, verify: verifyFixture, resolveNas: async () => config.nas,
    linkNas: async () => {
      await writeFile(final, partial);
      const error = new Error("hard links unavailable"); error.code = "ENOTSUP"; throw error;
    },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(summary, { received: 1, backedUp: 0, failed: 1 });
  assert.deepEqual(await readFile(final), partial);
  assert.deepEqual(remote.statuses, ["on_pc"]);
  assert.match(logs[0], /move it aside/);
});

test("truncated transfers and verification failures never receive an acknowledgement", async (t) => {
  const config = await fixture(t);
  for (const remote of [mockQueue({ responseBody: ciphertext.subarray(0, -1) }), mockQueue({ responseBody: Buffer.alloc(ciphertext.length, 4) }), mockQueue()]) {
    const summary = await runOnce(config, { fetcher: remote.fetcher, verify: async () => { throw new Error("wrong key"); } });
    assert.deepEqual(summary, { received: 0, backedUp: 0, failed: 1 });
    assert.deepEqual(remote.statuses, []);
    assert.deepEqual(await readdir(config.inbox), []);
  }
});

test("same-size PC copy from another upload never receives an acknowledgement", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue();
  const existing = Buffer.alloc(ciphertext.length, 3);
  const final = path.join(config.inbox, `${ID}.age`);
  await writeFile(final, existing);
  const summary = await runOnce(config, { fetcher: remote.fetcher, verify: verifyFixture });
  assert.deepEqual(summary, { received: 0, backedUp: 0, failed: 1 });
  assert.deepEqual(await readFile(final), existing);
  assert.equal(remote.downloads(), 0);
  assert.deepEqual(remote.statuses, []);
});

test("a malformed ID cannot reach a local path or child URL", async (t) => {
  const config = await fixture(t);
  const remote = mockQueue({ id: "../../somewhere" });
  await assert.rejects(runOnce(config, { fetcher: remote.fetcher, verify: verifyFixture }), /invalid upload record/);
  assert.equal(remote.downloads(), 0);
  assert.deepEqual(await readdir(config.inbox), []);
});
