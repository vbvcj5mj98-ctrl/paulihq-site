// Optional real local Worker/D1/R2 smoke test. Uses ephemeral resources only.
// Run on a platform supported by the installed workerd binary.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { encryptFile } from "../app/photo-drop/packet.ts";

const source = await readFile(new URL("../worker/photo-drop.ts", import.meta.url), "utf8");
const script = stripTypeScriptTypes(source, { mode: "transform" }) + `\nexport default { fetch(request, env) {
  return handlePhotoDrop(request, env, request.headers.get("x-test-username") || undefined);
} };`;
const origin = "http://paulihq.test";
const token = randomBytes(32).toString("base64url");
const recipient = await identityToRecipient(await generateIdentity());
const localState = await mkdtemp(join(process.cwd(), ".wrangler-photo-drop-smoke-"));
const mf = new Miniflare({
  host: "127.0.0.1", port: 0, modules: true, script,
  // The pinned local workerd binary ships with this maximum date. No live Worker is touched.
  compatibilityDate: "2026-05-22",
  bindings: { PHOTO_DROP_RECIPIENT: recipient, PHOTO_DROP_AGENT_TOKEN: token },
  d1Databases: { DB: "photo-drop-smoke" },
  r2Buckets: { PHOTO_DROP_BUCKET: "photo-drop-smoke" },
  d1Persist: join(localState, "d1"), r2Persist: join(localState, "r2"),
});
try {
  const db = await mf.getD1Database("DB");
  const migration = await readFile(new URL("../drizzle/0014_photo_drop.sql", import.meta.url), "utf8");
  await db.batch(migration.split(";").filter((statement) => statement.trim()).map((statement) => db.prepare(statement)));
  const bucket = await mf.getR2Bucket("PHOTO_DROP_BUCKET");
  const ciphertext = await encryptFile(new File(["No household data."], "test-photo.jpg", { type: "image/jpeg" }), recipient);
  const digest = createHash("sha256").update(new Uint8Array(await ciphertext.arrayBuffer())).digest("hex");
  const auth = { authorization: `Bearer ${token}` };
  const queued = await mf.dispatchFetch(`${origin}/api/photo-drop`, {
    method: "POST", body: ciphertext, headers: {
      origin, "content-type": "application/octet-stream", "content-length": String(ciphertext.size),
      "x-test-username": "carsonpauli", "x-photo-drop-upload-id": randomUUID(), "x-photo-drop-sha256": digest,
    },
  });
  const job = await queued.json();
  assert.equal(queued.status, 201, JSON.stringify(job));
  assert.equal(job.status, "queued");
  const objectKey = `photo-drop/v1/${job.id}.age`;
  assert.equal((await bucket.head(objectKey))?.size, ciphertext.size);
  const agent = `${origin}/api/photo-drop/agent/${job.id}`;
  const download = await mf.dispatchFetch(agent, { headers: auth });
  assert.equal(download.status, 200);
  assert.equal(createHash("sha256").update(new Uint8Array(await download.arrayBuffer())).digest("hex"), digest);
  for (const status of ["on_pc", "backed_up"]) {
    const ack = await mf.dispatchFetch(agent, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ status }),
    });
    assert.equal(ack.status, 200);
    assert.equal((await ack.json()).status, status);
  }
  assert.equal(await bucket.head(objectKey), null);
  console.log("Real local Worker, D1 and R2: encrypted upload, download, acknowledgement and purge passed.");
} finally {
  await mf.dispose();
}
