import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { restorePhoto } from "../scripts/photo-drop-restore.mjs";

function pack(file, overrides = {}) {
  const metadata = Buffer.from(JSON.stringify({ name: "../../never-use-this-path.png", type: "image/png", size: file.length, ...overrides }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  return Buffer.concat([prefix, metadata, file]);
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pauli-photo-restore-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputFolder = path.join(directory, "output");
  await mkdir(outputFolder);
  const identityPath = path.join(directory, "test-identity.txt");
  const identity = await generateX25519Identity();
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(identity));
  await writeFile(identityPath, `# Synthetic test key\r\n${identity}\r\n`);
  const original = randomBytes(64 * 1024 + 255);
  const ciphertext = Buffer.from(await encrypter.encrypt(pack(original, options)));
  const encryptedFile = path.join(directory, "a3b9ada7-f454-4aa1-b400-df412a6edcc6.age");
  await writeFile(encryptedFile, ciphertext);
  return { identityPath, encryptedFile, ciphertext, outputFolder, original, outputFile: path.join(outputFolder, "deliberate-name.jpg") };
}

test("restores the original bytes from an authenticated multi-chunk archive to the explicit filename", async (t) => {
  const files = await fixture(t);
  assert.equal(await restorePhoto(files), files.original.length);
  assert.deepEqual(await readFile(files.outputFile), files.original);
  assert.deepEqual(await readdir(files.outputFolder), ["deliberate-name.jpg"]);
  assert.deepEqual(await readFile(files.encryptedFile), files.ciphertext);
});

test("tampering with or truncating the final age chunk never creates plaintext", async (t) => {
  const files = await fixture(t);
  const tampered = Buffer.from(files.ciphertext);
  tampered[tampered.length - 1] ^= 0x80;
  for (const invalid of [tampered, files.ciphertext.subarray(0, -1)]) {
    await writeFile(files.encryptedFile, invalid);
    await assert.rejects(restorePhoto(files), /could not authenticate the full backup/);
    assert.deepEqual(await readdir(files.outputFolder), []);
  }
});

test("wrong X25519 key never writes an output file", async (t) => {
  const files = await fixture(t);
  await writeFile(files.identityPath, `${await generateX25519Identity()}\n`);
  await assert.rejects(restorePhoto(files), /could not authenticate/);
  assert.deepEqual(await readdir(files.outputFolder), []);
});

test("authenticated ciphertext with an invalid Photo Drop envelope is refused", async (t) => {
  const files = await fixture(t, { size: 1 });
  await assert.rejects(restorePhoto(files), /metadata and file length/);
  assert.deepEqual(await readdir(files.outputFolder), []);
});

test("will not overwrite an existing output or the encrypted source", async (t) => {
  const files = await fixture(t);
  const preexisting = Buffer.from("this data is not ours to replace");
  await writeFile(files.outputFile, preexisting);
  await assert.rejects(restorePhoto(files), /already exists and was left untouched/);
  assert.deepEqual(await readFile(files.outputFile), preexisting);
  await assert.rejects(restorePhoto({ ...files, outputFile: files.encryptedFile }), /already exists and was left untouched/);
  assert.deepEqual(await readFile(files.encryptedFile), files.ciphertext);
});

test("declines a non-local output and oversized encrypted input", async (t) => {
  const files = await fixture(t);
  await assert.rejects(restorePhoto({ ...files, outputFile: "relative.jpg" }), /absolute local path/);
  if (process.platform === "win32") {
    await assert.rejects(restorePhoto({ ...files, outputFile: "\\\\local-nas\\photos\\unencrypted.jpg" }), /absolute local path/);
    await assert.rejects(restorePhoto({ ...files, outputFile: `${files.outputFile}:alternate` }), /absolute local path/);
  }
  await truncate(files.encryptedFile, 26 * 1024 * 1024);
  await assert.rejects(restorePhoto(files), /within the size limit/);
  assert.deepEqual(await readdir(files.outputFolder), []);
});
