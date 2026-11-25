import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const MAX_ITEM_BYTES = 25 * 1024 * 1024 + 64 * 1024;
const MAX_BATCH_ITEMS = 100;
const MAX_METADATA_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LINK_UNSUPPORTED = new Set(["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);
const NAS_CONFLICT = "A NAS file is incomplete or different and was left untouched. Inspect it and move it aside if it is a partial copy, then retry. The PC still has its encrypted copy.";
const ENDPOINT = "/api/photo-drop/agent";
const PREFIX = "PAULI_PHOTO_DROP_";

function configuredPath(value, kind, platform) {
  if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${kind} must be an explicit absolute path.`);
  }
  if (platform === "win32") {
    const parts = value.replaceAll("/", "\\").split("\\");
    const isLocal = /^[a-z]:$/i.test(parts[0]) && parts.length > 1;
    const isUnc = parts[0] === "" && parts[1] === "" && parts.length >= 4;
    const tail = parts.slice(isUnc ? 2 : 1).filter((part, index, list) => part || index < list.length - 1);
    if ((kind === "NAS directory" ? !isUnc : !isLocal) || tail.length < (isUnc ? 2 : 1) || tail.some((segment) => !segment || /[<>:"|?*]|[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
      throw new Error(`${kind} must be ${kind === "NAS directory" ? "a dedicated UNC share or directory" : "an absolute drive path"}; device paths and traversal are not allowed.`);
    }
    return path.win32.normalize(value.replaceAll("/", "\\"));
  }
  if (!path.posix.isAbsolute(value) || value.split("/").some((segment) => segment === "." || segment === "..") || path.posix.normalize(value) === "/") {
    throw new Error(`${kind} must be an explicit absolute path without traversal.`);
  }
  return path.posix.normalize(value);
}

export function readConfig(env = process.env, platform = process.platform) {
  let origin;
  try {
    origin = new URL(env[`${PREFIX}ORIGIN`]);
  } catch {
    throw new Error(`${PREFIX}ORIGIN must be the live HTTPS site origin.`);
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error(`${PREFIX}ORIGIN must be the live HTTPS site origin, with no path or credentials.`);
  }
  const token = env[`${PREFIX}AGENT_TOKEN`];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error(`${PREFIX}AGENT_TOKEN must be a high-entropy bearer token of at least 32 characters.`);
  }
  const inbox = configuredPath(env[`${PREFIX}INBOX`], "PC inbox", platform);
  const nas = configuredPath(env[`${PREFIX}NAS`], "NAS directory", platform);
  const identity = configuredPath(env[`${PREFIX}AGE_IDENTITY`], "Age identity", platform);
  const ageBin = env[`${PREFIX}AGE_BINARY`] || "age";
  if (ageBin !== "age" && ageBin !== "age.exe") configuredPath(ageBin, "Age executable", platform);
  return { origin: origin.origin, token, inbox, nas, identity, ageBin, platform };
}

function sameOrWithin(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function checkedDirectory(input, message) {
  try {
    const entry = await lstat(input);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid directory");
    return await realpath(input);
  } catch {
    throw new Error(message);
  }
}

function checkSize(bytes) {
  return Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= MAX_ITEM_BYTES;
}

function filePath(directory, id) {
  if (!UUID.test(id)) throw new Error("Invalid upload ID.");
  return path.join(directory, `${id}.age`);
}

async function entryOrMissing(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function openChecked(filename, expected, flags = constants.O_RDONLY) {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== expected) {
    throw new Error("An existing file is not a regular file of the expected size; left it untouched.");
  }
  const file = await open(filename, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== expected || opened.ino !== entry.ino || opened.dev !== entry.dev) {
      throw new Error("File changed before verification; left it untouched.");
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function digestFile(filename, expected, sync = false) {
  const file = await openChecked(filename, expected, sync ? constants.O_RDWR : constants.O_RDONLY);
  const digest = createHash("sha256");
  let size = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > expected) throw new Error("File grew while being verified.");
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (size !== expected) throw new Error("File changed while being verified.");
    if (sync) await file.sync();
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

async function writeTemp(directory, getSource, expected, fileReady) {
  const filename = path.join(directory, `.photo-drop-${randomUUID()}.partial`);
  const file = await open(filename, "wx", 0o600);
  try {
    let size = 0;
    for await (const chunk of await getSource()) {
      size += chunk.length;
      if (size > expected) throw new Error("The ciphertext is larger than expected.");
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
        if (!bytesWritten) throw new Error("The ciphertext could not be written.");
        offset += bytesWritten;
      }
    }
    if (size !== expected) throw new Error("The ciphertext ended before the expected size.");
    await file.sync();
    await file.close();
    return await fileReady(filename);
  } finally {
    await file.close().catch(() => undefined);
    await unlink(filename).catch(() => undefined);
  }
}

async function checkNasCopy(filename, expected, digest) {
  try {
    if (await digestFile(filename, expected, true) === digest) return;
  } catch {
    // Leave any existing final name in place; the user decides what to do with it.
  }
  throw new Error(NAS_CONFLICT);
}

async function publishVerified(temp, final, expected, digest, nasLink) {
  // Hard-link the synced temporary file into place. Unlike rename(), link()
  // will not replace an existing file. Some older shares disallow hard links.
  // Exclusive copy is non-atomic but still never replaces a final name.
  try {
    await (nasLink ?? link)(temp, final);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      if (!nasLink || !LINK_UNSUPPORTED.has(error?.code)) throw new Error("The folder does not support safe file placement or is unavailable.");
      try {
        await copyFile(temp, final, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError?.code !== "EEXIST") throw new Error(NAS_CONFLICT);
      }
    }
  }
  if (nasLink) await checkNasCopy(final, expected, digest);
  else if (await digestFile(final, expected) !== digest) throw new Error("File verification failed; left the existing copy untouched.");
}

export async function verifyEnvelope(stream, maxPlainBytes) {
  const header = Buffer.alloc(4 + MAX_METADATA_BYTES);
  let headerSize = 0;
  let headerRequired = 4;
  let metadata;
  let seen = 0;
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length && !metadata) {
      const take = Math.min(chunk.length - start, headerRequired - headerSize);
      chunk.copy(header, headerSize, start, start + take);
      start += take;
      headerSize += take;
      if (headerSize !== headerRequired) break;
      if (headerRequired === 4) {
        const jsonBytes = header.readUInt32BE(0);
        if (jsonBytes < 2 || jsonBytes > MAX_METADATA_BYTES) throw new Error("Invalid encrypted file envelope.");
        headerRequired += jsonBytes;
      } else {
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(header.subarray(4, headerRequired));
          const json = JSON.parse(decoded);
          if (!json || Array.isArray(json) || typeof json.name !== "string" || !json.name || /[\x00-\x1f\x7f]/.test(json.name) || typeof json.type !== "string" || /[\x00-\x1f\x7f]/.test(json.type) || !Number.isSafeInteger(json.size) || json.size < 0 || json.size > maxPlainBytes) throw new Error();
          metadata = json;
        } catch {
          throw new Error("Invalid encrypted file metadata.");
        } finally {
          header.fill(0);
        }
      }
    }
    if (!metadata) continue;
    seen += chunk.length - start;
    if (seen > metadata.size) throw new Error("The decrypted data does not match the encrypted file envelope.");
  }
  if (!metadata || seen !== metadata.size) throw new Error("The decrypted data is incomplete.");
}

async function verifyWithAge(filename, expected, { ageBin, identity }) {
  // Prevent the service token from being inherited by the external verifier.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== `${PREFIX}AGENT_TOKEN`));
  const child = spawn(ageBin, ["--decrypt", "--identity", identity, filename], {
    env: childEnv,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 180_000,
    windowsHide: true,
    shell: false,
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not start age. Install the official age CLI and check its location.")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Age could not authenticate or fully decrypt the backup.")));
  });
  try {
    await Promise.all([exited, verifyEnvelope(child.stdout, expected)]);
  } catch (error) {
    child.kill();
    await exited.catch(() => undefined);
    throw error;
  }
}

function bridgeRequest(fetcher, config, endpoint, update) {
  const headers = { authorization: `Bearer ${config.token}` };
  const request = { headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(180_000) };
  if (update) {
    request.method = "POST";
    headers["content-type"] = "application/json";
    request.body = JSON.stringify({ status: update });
  }
  return fetcher(new URL(`${ENDPOINT}${endpoint}`, config.origin), request);
}

async function receiveFile(request, item, config, verify) {
  const final = filePath(config.inbox, item.id);
  if (await entryOrMissing(final)) {
    const digest = await digestFile(final, item.bytes);
    if (digest !== item.sha256) throw new Error("The PC copy does not match the verified upload checksum.");
    await verify(final, item.bytes, config);
    if (await digestFile(final, item.bytes) !== digest) throw new Error("The PC copy changed during verification.");
    return { final, digest };
  }
  return writeTemp(config.inbox, async () => {
    const response = await request(`/${item.id}`);
    if (!response.ok || !response.body) throw new Error(`The encrypted transfer could not be opened (HTTP ${response.status}).`);
    const length = response.headers.get("content-length");
    if (length !== null && length !== String(item.bytes)) {
      await response.body.cancel();
      throw new Error("The encrypted transfer has an unexpected length.");
    }
    return Readable.fromWeb(response.body);
  }, item.bytes, async (temp) => {
    const digest = await digestFile(temp, item.bytes);
    if (digest !== item.sha256) throw new Error("The download does not match the verified upload checksum.");
    await verify(temp, item.bytes, config);
    await publishVerified(temp, final, item.bytes, digest);
    return { final, digest };
  });
}

async function resolveNasDirectory(config) {
  const root = await checkedDirectory(config.nas, "The configured NAS folder is unavailable. The encrypted copy is still on the PC.");
  return configuredPath(root, "NAS directory", config.platform);
}

async function backupFile(item, local, config, resolveNas, linkNas) {
  const root = await resolveNas(config);
  if (sameOrWithin(root, config.inbox) || sameOrWithin(config.inbox, root) || sameOrWithin(root, config.identity)) {
    throw new Error("The PC inbox, recovery key, and NAS folder must be separate; no backup was marked complete.");
  }
  const final = filePath(root, item.id);
  if (await entryOrMissing(final)) {
    await checkNasCopy(final, item.bytes, local.digest);
    return;
  }
  await writeTemp(root, async () => {
    const file = await openChecked(local.final, item.bytes);
    return file.createReadStream();
  }, item.bytes, async (temp) => {
    if (await digestFile(temp, item.bytes) !== local.digest) throw new Error("NAS copy checksum does not match the PC copy.");
    await publishVerified(temp, final, item.bytes, local.digest, linkNas);
  });
}

async function updateStatus(request, id, status) {
  const response = await request(`/${id}`, status);
  if (!response.ok) throw new Error(`Pauli HQ did not confirm the '${status}' status (HTTP ${response.status}).`);
  await response.body?.cancel();
}

export async function runOnce(input, { fetcher = fetch, verify = verifyWithAge, resolveNas = resolveNasDirectory, linkNas = link, log = () => {} } = {}) {
  const inbox = await checkedDirectory(input.inbox, "The configured PC inbox does not exist or is not an ordinary folder.");
  configuredPath(inbox, "PC inbox", input.platform);
  let identity;
  try {
    const entry = await lstat(input.identity);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid key path");
    identity = await realpath(input.identity);
    configuredPath(identity, "Age identity", input.platform);
  } catch {
    throw new Error("The configured Age identity is not a regular local file.");
  }
  if (sameOrWithin(inbox, identity)) throw new Error("Keep the Age identity outside the inbox.");
  const config = { ...input, inbox, identity };
  const request = (endpoint = "", update) => bridgeRequest(fetcher, config, endpoint, update);
  const response = await request();
  if (!response.ok) throw new Error(`Pauli HQ did not return the upload queue (HTTP ${response.status}).`);
  const result = await response.json();
  if (!Array.isArray(result?.items) || result.items.length > MAX_BATCH_ITEMS) throw new Error("Pauli HQ returned an invalid upload queue.");

  const summary = { received: 0, backedUp: 0, failed: 0 };
  const ids = new Set();
  for (const item of result.items) {
    if (!item || typeof item.id !== "string" || !UUID.test(item.id) || !checkSize(item.bytes) || typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || (item.status !== "queued" && item.status !== "on_pc") || ids.has(item.id)) throw new Error("Pauli HQ returned an invalid upload record.");
    ids.add(item.id);
  }
  for (const item of result.items) {
    let stage = "PC copy";
    try {
      const local = await receiveFile(request, item, config, verify);
      summary.received++;
      stage = "PC receipt";
      if (item.status !== "on_pc") await updateStatus(request, item.id, "on_pc");
      stage = "NAS copy";
      await backupFile(item, local, config, resolveNas, linkNas);
      stage = "NAS receipt";
      await updateStatus(request, item.id, "backed_up");
      summary.backedUp++;
      log(`${item.id}: Encrypted backup verified on the NAS.`);
    } catch (error) {
      summary.failed++;
      // Raw filesystem and network errors can expose private local paths.
      const message = error?.code || (error instanceof Error ? error.message : "Unexpected error");
      log(`${item.id}: ${stage} failed (${message}).`);
    }
  }
  return summary;
}

const isExecutable = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isExecutable) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--once") throw new Error("Usage: node scripts/photo-drop-bridge.mjs --once");
    const result = await runOnce(readConfig(), { log: (message) => console.log(message) });
    console.log(`PC copies verified: ${result.received}. NAS backups confirmed: ${result.backedUp}. Pending or failed: ${result.failed}.`);
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(error?.code || (error instanceof Error ? error.message : "Photo Drop failed."));
    process.exitCode = 1;
  }
}
