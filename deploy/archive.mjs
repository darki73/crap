import { createReadStream, createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const magic = Buffer.from("CRAPWS01");
function key(password, salt) {
  if (
    typeof password !== "string" ||
    password.length < 16 ||
    password.length > 1024
  )
    throw new Error("Use a backup passphrase of 16–1024 characters.");
  return scryptSync(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
}
export async function encryptArchive(source, destination, password) {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    header = Buffer.concat([magic, salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", key(password, salt), iv);
  cipher.setAAD(header);
  const file = await open(destination, "wx", 0o600);
  try {
    await file.write(header);
    await pipeline(
      createReadStream(source),
      cipher,
      createWriteStream(destination, { flags: "a" }),
    );
    await file.write(cipher.getAuthTag(), 0, 16, (await file.stat()).size);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(destination).catch(() => {});
    throw error;
  }
  await file.close();
}
// No caller may extract or use the clear archive until GCM authentication has
// completed. Failed or interrupted authentication removes the private output.
export async function decryptArchive(source, destination, password) {
  const input = await open(source, "r");
  let created = false;
  try {
    const { size } = await input.stat();
    if (size < 52) throw new Error("Invalid workspace backup.");
    const header = Buffer.alloc(36),
      tag = Buffer.alloc(16);
    await input.read(header, 0, 36, 0);
    await input.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 8).equals(magic))
      throw new Error("Invalid workspace backup.");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key(password, header.subarray(8, 24)),
      header.subarray(24),
    );
    cipher.setAAD(header);
    cipher.setAuthTag(tag);
    const out = await open(destination, "wx", 0o600);
    await out.close();
    created = true;
    await pipeline(
      createReadStream(source, { start: 36, end: size - 17 }),
      cipher,
      createWriteStream(destination, { flags: "a" }),
    );
  } catch (error) {
    if (created) await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await input.close();
  }
}
