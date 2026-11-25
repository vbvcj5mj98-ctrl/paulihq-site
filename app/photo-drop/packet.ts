export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function recipientFingerprint(recipient: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recipient));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function encryptFile(file: File, recipient: string): Promise<Blob> {
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new Error("Choose a file between 1 byte and 25 MB.");
  const metadata = new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type, size: file.size }));
  if (metadata.byteLength > 4096) throw new Error("The file name is too long.");
  const prefix = new ArrayBuffer(4);
  new DataView(prefix).setUint32(0, metadata.byteLength, false);
  const packet = new Blob([prefix, metadata, file]);
  const { Encrypter } = await import("age-encryption");
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(packet.stream());
  return new Response(encrypted).blob();
}
