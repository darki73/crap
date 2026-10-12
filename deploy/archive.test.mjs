import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encryptArchive, decryptArchive } from "./archive.mjs";
test("workspace archives authenticate all contents, reject tampering and never overwrite files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "crap-archive-"));
  try {
    const source = path.join(dir, "source"),
      encrypted = path.join(dir, "backup"),
      restored = path.join(dir, "restored"),
      bad = path.join(dir, "bad");
    const password = "fixture-passphrase-only";
    await writeFile(source, "private-fixture-identity-and-spool");
    await encryptArchive(source, encrypted, password);
    assert.ok(
      !(await readFile(encrypted)).includes(Buffer.from("private-fixture")),
    );
    await decryptArchive(encrypted, restored, password);
    assert.deepEqual(await readFile(restored), await readFile(source));
    await assert.rejects(encryptArchive(source, encrypted, password));
    await assert.rejects(decryptArchive(encrypted, restored, password));
    await assert.rejects(
      decryptArchive(encrypted, bad, "wrong-fixture-passphrase"),
    );
    await assert.rejects(access(bad));
    const corrupted = await readFile(encrypted);
    corrupted[40] ^= 1;
    await writeFile(encrypted, corrupted);
    await assert.rejects(decryptArchive(encrypted, bad, password));
    await assert.rejects(access(bad));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
