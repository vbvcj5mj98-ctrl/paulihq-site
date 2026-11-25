import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { encryptFile, MAX_FILE_BYTES, recipientFingerprint } from "../app/photo-drop/packet.ts";

test("the browser encrypts the original name, type, and bytes in a restorable age file", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const contents = "Photo Drop synthetic test data!";
  const filename = "private-name-test.jpg";
  const input = new File([contents], filename, { type: "image/jpeg" });

  const encrypted = Buffer.from(await (await encryptFile(input, recipient)).arrayBuffer());
  assert.ok(encrypted.subarray(0, 22).equals(Buffer.from("age-encryption.org/v1\n")));
  assert.equal(encrypted.includes(filename), false);
  assert.equal(encrypted.includes(contents), false);
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const verified = Buffer.from(await decrypter.decrypt(encrypted));
  const metadataBytes = verified.readUInt32BE(0);
  assert.deepEqual(JSON.parse(verified.subarray(4, metadataBytes + 4).toString()), { name: filename, type: "image/jpeg", size: input.size });
  assert.equal(verified.subarray(metadataBytes + 4).toString(), contents);

  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(decrypter.decrypt(encrypted));
  assert.equal(await recipientFingerprint(recipient), createHash("sha256").update(recipient).digest("hex").slice(0, 16));
});

test("empty and oversized files are refused before any encryption", async () => {
  await assert.rejects(encryptFile(new File([], "empty"), "not-used"), /between 1 byte and 25 MB/);
  await assert.rejects(encryptFile(new File([new ArrayBuffer(MAX_FILE_BYTES + 1)], "too-large"), "not-used"), /between 1 byte and 25 MB/);
});
