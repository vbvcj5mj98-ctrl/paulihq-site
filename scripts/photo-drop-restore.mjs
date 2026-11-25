import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Decrypter } from "age-encryption";

const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
const MAX_METADATA_BYTES = 4096;
const MAX_IDENTITY_BYTES = 16 * 1024;
const AGE_HEADER = Buffer.from("age-encryption.org/v1\n", "ascii");
const utf8 = new TextDecoder("utf-8", { fatal: true });

function localPath(value, label) {
  let valid = typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);
  if (valid && process.platform === "win32") {
    valid = /^[A-Za-z]:[\\/]/.test(value) && value.slice(3).split(/[\\/]/).every((segment) => (
      !/[<>:"|?*]|[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    ));
  }
  if (valid && process.platform !== "win32") valid = !value.split("/").some((segment) => segment === "." || segment === "..");
  if (!valid) throw new Error(`${label} must be an absolute local path without device names or traversal.`);
  return path.normalize(value);
}

async function readBounded(filename, limit, label) {
  let buffer;
  let file;
  try {
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > limit) throw new Error();
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (!opened.isFile() || entry.ino !== opened.ino || entry.dev !== opened.dev || entry.size !== opened.size) throw new Error();
    buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error();
      offset += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error();
    return buffer;
  } catch {
    buffer?.fill(0);
    throw new Error(`${label} could not be read as an ordinary file within the size limit.`);
  } finally {
    await file?.close();
  }
}

async function makeDecrypter(keyPath) {
  const configured = localPath(keyPath, "The Age identity path");
  try { localPath(await realpath(configured), "The Age identity path"); }
  catch { throw new Error("The Age identity is unavailable as a local file."); }
  const keyFile = await readBounded(configured, MAX_IDENTITY_BYTES, "The Age identity");
  try {
    const keys = utf8.decode(keyFile).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (keys.length < 1 || keys.length > 8 || keys.some((key) => !/^AGE-SECRET-KEY-1[A-Z0-9]+$/.test(key))) throw new Error();
    const decrypt = new Decrypter();
    for (const key of keys) decrypt.addIdentity(key);
    return decrypt;
  } catch {
    throw new Error("Use a standard Age X25519 identity file created with age-keygen.");
  } finally {
    keyFile.fill(0);
  }
}

function unpack(plain) {
  if (plain.byteLength < 7 || plain.byteLength > 4 + MAX_METADATA_BYTES + MAX_PHOTO_BYTES) throw new Error("The decrypted file is not a valid Photo Drop package.");
  const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (length < 2 || length > MAX_METADATA_BYTES || length + 4 >= plain.byteLength) throw new Error("The decrypted file is not a valid Photo Drop package.");
  const contents = plain.subarray(4 + length);
  try {
    const data = JSON.parse(utf8.decode(plain.subarray(4, 4 + length)));
    if (!data || Array.isArray(data) || typeof data.name !== "string" || !data.name || /[\x00-\x1f\x7f]/.test(data.name) || typeof data.type !== "string" || /[\x00-\x1f\x7f]/.test(data.type) || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_PHOTO_BYTES || contents.byteLength !== data.size) throw new Error();
  } catch {
    throw new Error("The decrypted metadata and file length do not match a Photo Drop package.");
  }
  // The metadata name is never used to pick a path or printed.
  return contents;
}

async function selectedOutput(filename) {
  const explicit = localPath(filename, "The output file");
  if (/[\\/]$/.test(filename) || path.basename(explicit) === "") throw new Error("Choose an explicit output filename, not a folder.");
  try {
    const directory = path.dirname(explicit);
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
    const resolved = localPath(await realpath(directory), "The output folder");
    return path.join(resolved, path.basename(explicit));
  } catch {
    throw new Error("The output folder must already exist on a local drive and cannot be a link.");
  }
}

async function writeNewFile(filename, contents) {
  let file;
  try {
    file = await open(filename, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("The output already exists and was left untouched. Pick a new filename.");
    throw new Error("The output file could not be created.");
  }
  let created;
  try {
    created = await file.stat();
    await file.writeFile(contents);
    await file.sync();
    await file.close();
  } catch {
    await file.close().catch(() => undefined);
    let removed = false;
    try {
      const current = await lstat(filename);
      if (created && current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) {
        await unlink(filename);
        removed = true;
      }
    } catch { /* Do not touch an unknown or replaced file. */ }
    throw new Error(removed ? "The restore could not be completed. Its incomplete output was removed." : "The restore could not be completed. Check the chosen location for an incomplete output before retrying.");
  }
}

export async function restorePhoto({ encryptedFile, outputFile, identityPath }) {
  if (typeof encryptedFile !== "string" || path.extname(encryptedFile).toLowerCase() !== ".age") throw new Error("Choose an encrypted .age Photo Drop file.");
  const output = await selectedOutput(outputFile);
  const decrypt = await makeDecrypter(identityPath);
  const encrypted = await readBounded(encryptedFile, MAX_CIPHERTEXT_BYTES, "The encrypted input");
  let plain;
  try {
    if (!encrypted.subarray(0, AGE_HEADER.length).equals(AGE_HEADER)) throw new Error();
    // The buffer overload consumes the complete age stream, including its
    // authenticated final chunk, before returning any plaintext to this code.
    plain = await decrypt.decrypt(encrypted);
  } catch {
    throw new Error("Age could not authenticate the full backup. Check the file and the recovery key. Nothing was restored.");
  }
  try {
    const contents = unpack(plain);
    await writeNewFile(output, contents);
    return contents.byteLength;
  } finally {
    plain.fill(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/photo-drop-restore.mjs <encrypted.age> <absolute-local-output-file>");
    const bytes = await restorePhoto({ encryptedFile: process.argv[2], outputFile: process.argv[3], identityPath: process.env.PAULI_PHOTO_DROP_AGE_IDENTITY });
    console.log(`Restored ${bytes} bytes to the selected output file.`);
  } catch (error) {
    console.error(error?.code || (error instanceof Error ? error.message : "Photo Drop restore failed."));
    process.exitCode = 1;
  }
}
