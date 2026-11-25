const resourcePath = "/api/photo-drop";
const agentPath = `${resourcePath}/agent`;
const ageMagic = new TextEncoder().encode("age-encryption.org/v1\n");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenFormat = /^[A-Za-z0-9_-]{32,128}$/;
const sha256Hex = /^[0-9a-f]{64}$/;
const allowedUsers = new Set(["carsonpauli", "jessipauli"]);
const itemLimit = 25 * 1024 * 1024 + 64 * 1024;
const pendingByteLimit = 2 * 1024 * 1024 * 1024;
const dailyOwnerLimit = 200;
const pendingItemLimit = 200;
const pendingLifetime = 7 * 24 * 60 * 60 * 1000;
const stagingLifetime = 60 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;
const statusLifetime = 30 * day;
const utf8 = new TextEncoder();

export interface PhotoDropEnv {
  DB: D1Database;
  PHOTO_DROP_BUCKET?: R2Bucket;
  PHOTO_DROP_RECIPIENT?: string;
  PHOTO_DROP_AGENT_TOKEN?: string;
}

type Configured = PhotoDropEnv & {
  PHOTO_DROP_BUCKET: R2Bucket;
  PHOTO_DROP_RECIPIENT: string;
  PHOTO_DROP_AGENT_TOKEN: string;
};

type Phase = "staging" | "queued" | "on_pc" | "backed_up" | "expired";
type Row = {
  id: string;
  status: Phase;
  bytes: number;
  created_at: number;
  expires_at: number;
  cipher_sha256: string;
  object_deleted_at: number | null;
};

const listColumns = "id, status, bytes, created_at, expires_at, cipher_sha256, object_deleted_at";

class PhotoDropError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function photoDropAllowed(username: string): boolean {
  return allowedUsers.has(username);
}

function validAgeRecipient(recipient: string) {
  // Standard X25519 age recipient: 52 five-bit data groups followed by six
  // Bech32 checksum groups. Never serve a secret or a malformed public key.
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  if (!/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(recipient)) return false;
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const groups = Array.from(recipient.slice(4), (char) => alphabet.indexOf(char));
  // The last data group uses one bit of the 256-bit key and has four zero pad bits.
  if ((groups[51] & 15) !== 0) return false;
  let check = 1;
  for (const value of [3, 3, 3, 0, 1, 7, 5, ...groups]) {
    const upper = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < generators.length; i++) if ((upper >>> i) & 1) check ^= generators[i];
  }
  return check === 1;
}

export function canConfigurePhotoDrop(env: PhotoDropEnv): env is Configured {
  return Boolean(env.PHOTO_DROP_BUCKET
    && validAgeRecipient(env.PHOTO_DROP_RECIPIENT ?? "")
    && tokenFormat.test(env.PHOTO_DROP_AGENT_TOKEN ?? ""));
}

function reply(value: Record<string, unknown>, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  } });
}

function methodNotAllowed(allow: string) {
  return reply({ error: "Method not allowed." }, 405, { allow });
}

function serialize(row: Row, now = Date.now()) {
  const status = row.status !== "backed_up" && row.expires_at <= now ? "expired" : row.status;
  return { id: row.id, status, bytes: row.bytes, createdAt: row.created_at, expiresAt: row.expires_at };
}

function objectKey(id: string) {
  return `photo-drop/v1/${id}.age`;
}

function mediaType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
}

function checkBrowserOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new PhotoDropError(403, "Open Photo Drop from Pauli HQ to upload.");
  }
}

function fileBytes(request: Request): number {
  const length = request.headers.get("content-length");
  if (!length || !/^\d{1,10}$/.test(length) || !request.body) {
    throw new PhotoDropError(411, "The upload must have a known size.");
  }
  const bytes = Number(length);
  if (bytes > itemLimit) throw new PhotoDropError(413, "The encrypted file exceeds the 25 MiB file limit.");
  if (bytes <= ageMagic.length) throw new PhotoDropError(400, "The encrypted file is missing or incomplete.");
  return bytes;
}

function retryIdentity(request: Request) {
  const clientId = request.headers.get("x-photo-drop-upload-id");
  const digest = request.headers.get("x-photo-drop-sha256");
  if (clientId === null || !uuid.test(clientId) || digest === null || !sha256Hex.test(digest)) {
    throw new PhotoDropError(400, "The upload retry identifier is invalid.");
  }
  return { clientId, digest };
}

function digestBytes(value: string) {
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)).buffer;
}

async function tokenMatches(request: Request, secret: string) {
  const authorization = request.headers.get("authorization") ?? "";
  const candidate = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/i)?.[1];
  if (!candidate) return false;
  const digests = await Promise.all([candidate, secret].map((value) => crypto.subtle.digest("SHA-256", utf8.encode(value))));
  const [left, right] = digests.map((digest) => new Uint8Array(digest));
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function readAck(request: Request): Promise<"on_pc" | "backed_up"> {
  if (mediaType(request) !== "application/json") throw new PhotoDropError(415, "Send a JSON status.");
  const reader = request.body?.getReader();
  if (!reader) throw new PhotoDropError(400, "A backup status is required.");
  const buffer = new Uint8Array(256);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.length > buffer.length - length) {
        await reader.cancel();
        throw new PhotoDropError(413, "The backup status is too large.");
      }
      buffer.set(chunk.value, length);
      length += chunk.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } catch {
    throw new PhotoDropError(400, "The backup status is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 1 || !("status" in value)
    || (value.status !== "on_pc" && value.status !== "backed_up")) {
    throw new PhotoDropError(400, "The backup status is invalid.");
  }
  return value.status;
}

async function writeCiphertext(body: ReadableStream<Uint8Array>, bucket: R2Bucket, id: string, bytes: number, digest: string) {
  let read = 0;
  const validate = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.byteLength > bytes - read) throw new PhotoDropError(400, "The upload did not match its declared size.");
      for (let i = 0; i < chunk.byteLength && read + i < ageMagic.length; i++) {
        if (chunk[i] !== ageMagic[read + i]) throw new PhotoDropError(400, "The file is not an age-encrypted upload.");
      }
      read += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      if (read !== bytes) throw new PhotoDropError(400, "The upload ended before the complete file arrived.");
    },
  });
  // R2 accepts an incoming stream with a known length. Keep the enforced length
  // through the guard so neither the Worker nor R2 buffers the whole upload.
  const target = new FixedLengthStream(bytes);
  const [object, pump] = await Promise.allSettled([
    bucket.put(objectKey(id), target.readable, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
      sha256: digestBytes(digest),
    }).then((stored) => {
      if (!stored) throw new PhotoDropError(409, "An upload with this identifier already exists.");
      return stored;
    }).catch(async (error: unknown) => {
      // If R2 refuses the request before acquiring its input, unblock the pump.
      if (!target.readable.locked) await target.readable.cancel().catch(() => {});
      throw error;
    }),
    body.pipeThrough(validate).pipeTo(target.writable),
  ]);
  if (pump.status === "rejected" && pump.reason instanceof PhotoDropError) throw pump.reason;
  if (object.status === "rejected") throw object.reason;
  if (pump.status === "rejected") throw pump.reason;
}

async function abortStaging(env: Configured, id: string) {
  const now = Date.now();
  const { meta } = await env.DB.prepare("UPDATE photo_drop_uploads SET status = 'expired', expires_at = ?, updated_at = ? WHERE id = ? AND status = 'staging'")
    .bind(now, now, id).run();
  if (!meta.changes) return;
  await env.PHOTO_DROP_BUCKET.delete(objectKey(id));
  await env.DB.prepare("UPDATE photo_drop_uploads SET object_deleted_at = ? WHERE id = ? AND status = 'expired'")
    .bind(now, id).run();
}

async function putFile(request: Request, env: Configured, owner: string) {
  checkBrowserOrigin(request);
  if (mediaType(request) !== "application/octet-stream") {
    throw new PhotoDropError(415, "Only encrypted files can be uploaded.");
  }
  const bytes = fileBytes(request);
  const { clientId, digest } = retryIdentity(request);
  const id = crypto.randomUUID();
  const now = Date.now();
  const reservation = await env.DB.prepare(`INSERT OR IGNORE INTO photo_drop_uploads
    (id, owner, client_id, cipher_sha256, status, bytes, created_at, updated_at, expires_at)
    SELECT ?, ?, ?, ?, 'staging', ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM photo_drop_uploads WHERE owner = ? AND created_at > ?) < ?
      AND (SELECT COUNT(*) FROM photo_drop_uploads WHERE status IN ('staging','queued','on_pc') AND expires_at > ?) < ?
      AND (SELECT COUNT(*) FROM photo_drop_uploads WHERE status = 'staging' AND expires_at > ?) < 2
      AND (SELECT COALESCE(SUM(bytes), 0) FROM photo_drop_uploads WHERE status IN ('staging','queued','on_pc') AND expires_at > ?) + ? <= ?`)
    .bind(id, owner, clientId, digest, bytes, now, now, now + stagingLifetime,
      owner, now - day, dailyOwnerLimit, now, pendingItemLimit, now, now, bytes, pendingByteLimit).run();
  if (!reservation.meta.changes) {
    const previous = await env.DB.prepare(`SELECT ${listColumns} FROM photo_drop_uploads WHERE owner = ? AND client_id = ?`)
      .bind(owner, clientId).first<Row>();
    if (previous) {
      if (previous.bytes !== bytes || previous.cipher_sha256 !== digest) {
        throw new PhotoDropError(409, "This retry identifier belongs to a different encrypted file.");
      }
      if (previous.status === "staging" && previous.expires_at > now) {
        throw new PhotoDropError(409, "This file is already uploading. Check its status before retrying.");
      }
      if (serialize(previous, now).status === "expired") {
        throw new PhotoDropError(410, "That upload expired. Retry to queue a new encrypted copy.");
      }
      return reply(serialize(previous, now));
    }
    throw new PhotoDropError(429, "The upload queue is busy or full. Try again after it clears.");
  }

  try {
    await writeCiphertext(request.body!, env.PHOTO_DROP_BUCKET, id, bytes, digest);
    const finished = Date.now();
    const expires = finished + pendingLifetime;
    const row = await env.DB.prepare(`UPDATE photo_drop_uploads SET status = 'queued', expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'staging' AND expires_at > ? RETURNING ${listColumns}`)
      .bind(expires, finished, id, finished).first<Row>();
    if (!row) {
      // An unusually late upload might complete after the expiry cleanup.
      await env.PHOTO_DROP_BUCKET.delete(objectKey(id));
      throw new PhotoDropError(410, "The upload timed out. Select the file again to retry.");
    }
    return reply(serialize(row, finished), 201);
  } catch (error) {
    await abortStaging(env, id).catch(() => {}); // Scheduled cleanup retries incomplete deletions.
    throw error;
  }
}

async function browser(request: Request, env: PhotoDropEnv, username?: string) {
  if (!username) return reply({ error: "Sign in to use Photo Drop." }, 401);
  if (!photoDropAllowed(username)) return reply({ error: "Photo Drop is not available for this account." }, 403);
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");
  if (!canConfigurePhotoDrop(env)) {
    return request.method === "GET"
      ? reply({ configured: false, recipient: null, items: [] })
      : reply({ error: "Photo Drop has not been connected to your PC yet." }, 503);
  }
  if (request.method === "POST") return putFile(request, env, username);
  const now = Date.now();
  const listing = await env.DB.prepare(`SELECT ${listColumns} FROM photo_drop_uploads
    WHERE owner = ? AND status != 'staging' AND created_at > ? ORDER BY created_at DESC LIMIT 200`)
    .bind(username, now - statusLifetime).all<Row>();
  return reply({ configured: true, recipient: env.PHOTO_DROP_RECIPIENT, items: listing.results.map((row) => serialize(row, now)) });
}

async function findRow(env: PhotoDropEnv, id: string) {
  return env.DB.prepare(`SELECT ${listColumns} FROM photo_drop_uploads WHERE id = ?`).bind(id).first<Row>();
}

async function removeBackedUpObject(env: Configured, row: Row) {
  if (row.status !== "backed_up" || row.object_deleted_at !== null) return;
  await env.PHOTO_DROP_BUCKET.delete(objectKey(row.id));
  await env.DB.prepare("UPDATE photo_drop_uploads SET object_deleted_at = ? WHERE id = ? AND status = 'backed_up'")
    .bind(Date.now(), row.id).run();
}

async function ack(request: Request, env: Configured, current: Row) {
  const target = await readAck(request);
  if (current.status !== "backed_up" && current.expires_at <= Date.now()) {
    throw new PhotoDropError(410, "The upload expired before backup completed.");
  }
  let row: Row | null = current;
  if (current.status !== "backed_up") {
    const expected = target === "on_pc" ? "queued" : "on_pc";
    const now = Date.now();
    row = await env.DB.prepare(`UPDATE photo_drop_uploads SET status = ?, updated_at = ?
      WHERE id = ? AND status = ? AND expires_at > ? RETURNING ${listColumns}`)
      .bind(target, now, current.id, expected, now).first<Row>() ?? await findRow(env, current.id);
    if (!row) throw new PhotoDropError(404, "The upload was not found.");
    if (row.status !== "backed_up" && row.expires_at <= Date.now()) throw new PhotoDropError(410, "The upload expired before backup completed.");
    if (row.status !== target && row.status !== "backed_up") {
      throw new PhotoDropError(409, "Record the verified PC copy before reporting NAS backup.");
    }
  }
  if (target === "backed_up") await removeBackedUpObject(env, row);
  return reply(serialize(row));
}

async function agent(request: Request, env: PhotoDropEnv, pathname: string) {
  const authFailure = () => reply({ error: "The PC connector is not authorized." }, 401, { "www-authenticate": "Bearer" });
  if (!canConfigurePhotoDrop(env) || !(await tokenMatches(request, env.PHOTO_DROP_AGENT_TOKEN))) return authFailure();
  if (pathname === agentPath) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const now = Date.now();
    const listing = await env.DB.prepare(`SELECT ${listColumns} FROM photo_drop_uploads
      WHERE status IN ('queued', 'on_pc') AND expires_at > ? ORDER BY created_at, id LIMIT 50`)
      .bind(now).all<Row>();
    return reply({ items: listing.results.map((row) => ({ ...serialize(row, now), sha256: row.cipher_sha256 })) });
  }

  const id = pathname.slice(agentPath.length + 1);
  if (!uuid.test(id)) throw new PhotoDropError(404, "The upload was not found.");
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");
  const row = await findRow(env, id);
  if (!row || row.status === "staging") throw new PhotoDropError(404, "The upload was not found.");
  if (request.method === "POST") return ack(request, env, row);
  if (row.status === "expired" || row.status === "backed_up" || row.expires_at <= Date.now()) {
    throw new PhotoDropError(410, "This upload is no longer queued for download.");
  }
  const stored = await env.PHOTO_DROP_BUCKET.get(objectKey(id));
  if (!stored || stored.size !== row.bytes) throw new PhotoDropError(503, "The encrypted upload is not currently available.");
  return new Response(stored.body, { headers: {
    "content-type": "application/octet-stream",
    "content-length": String(stored.size),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  } });
}

export async function handlePhotoDrop(request: Request, env: PhotoDropEnv, username?: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === resourcePath) return await browser(request, env, username);
    if (pathname === agentPath || pathname.startsWith(`${agentPath}/`)) return await agent(request, env, pathname);
    return reply({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof PhotoDropError) return reply({ error: error.message }, error.status);
    // Do not log credentials, identifiers, or information supplied by an uploader.
    console.error("Photo Drop request could not complete.");
    return reply({ error: "Photo Drop is temporarily unavailable. Please try again." }, 503);
  }
}

export async function cleanupPhotoDrop(env: PhotoDropEnv) {
  if (!canConfigurePhotoDrop(env)) return;
  const now = Date.now();
  // Commit terminal state before removing the object. Suppress status records
  // only after deletion is recorded, so partial cleanup can safely be retried.
  await env.DB.prepare(`UPDATE photo_drop_uploads SET status = 'expired', updated_at = ?
    WHERE status IN ('staging','queued','on_pc') AND expires_at <= ?`).bind(now, now).run();
  const due = await env.DB.prepare(`SELECT id FROM photo_drop_uploads
    WHERE status IN ('expired', 'backed_up') AND object_deleted_at IS NULL ORDER BY updated_at LIMIT 200`).all<{ id: string }>();
  if (due.results.length) {
    await env.PHOTO_DROP_BUCKET.delete(due.results.map(({ id }) => objectKey(id)));
    // D1 has a 100-bound-parameter limit per statement; even the full batch
    // uses just three updates and stays below the Free plan's query limit.
    for (let i = 0; i < due.results.length; i += 99) {
      const ids = due.results.slice(i, i + 99).map(({ id }) => id);
      await env.DB.prepare(`UPDATE photo_drop_uploads SET object_deleted_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(now, ...ids).run();
    }
  }
  await env.DB.prepare(`DELETE FROM photo_drop_uploads
    WHERE status IN ('expired', 'backed_up') AND object_deleted_at < ? AND created_at < ?`)
    .bind(now - statusLifetime, now - statusLifetime).run();
}
