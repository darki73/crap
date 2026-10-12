import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// One shared reader owns this file in local development. It is not a
// cross-process lease; quota-admission.mjs provides database coordination.
export function createQuotaCache(file) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  let entries = {};
  const loaded = path
    ? readFile(path, "utf8")
        .then((value) => {
          const parsed = JSON.parse(value);
          if (
            parsed.version !== 1 ||
            !parsed.entries ||
            typeof parsed.entries !== "object"
          )
            throw new Error("Invalid quota cache.");
          entries = parsed.entries;
        })
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        })
    : Promise.resolve();
  let writes = Promise.resolve();
  return {
    async get(key) {
      await loaded;
      return entries[key];
    },
    async set(key, value) {
      await loaded;
      entries[key] = value;
      if (!path) return;
      const data = JSON.stringify({ version: 1, entries });
      const write = writes
        .catch(() => {})
        .then(async () => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(`${path}.tmp`, data, { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        });
      writes = write;
      await write;
    },
  };
}
