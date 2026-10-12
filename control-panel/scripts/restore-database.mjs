// Input comes from stdin, never command arguments containing credentials.
// Use --native with PostgreSQL 17 client tools inside a Kubernetes Job/pod.
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  connection,
  privateDirectory,
  unsealBundle,
  postgresTools,
  writeDeployment,
} from "../database-transfer.mjs";

try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 100000) throw new Error("Input too large.");
  }
  const input = JSON.parse(raw);
  if (input.confirm !== "restore-into-empty-database")
    throw new Error("Explicit restore confirmation is required.");
  const target = connection(input.target);
  const directory = path.resolve(input.outputDirectory);
  // Refuse an existing output directory, so repeated runs cannot mix credentials.
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const pg = postgresTools(
    directory,
    undefined,
    process.argv.includes("--native"),
  );
  await pg.inspect(target, true);
  const { manifest, dump } = await unsealBundle(
    path.resolve(input.backup),
    directory,
    input.passphrase,
  );
  try {
    await pg.restore(target, manifest.counts);
    await writeDeployment(directory, target, manifest.secrets, manifest);
  } finally {
    await unlink(dump).catch(() => {});
  }
  console.log(
    "Both schemas restored and row counts verified. Deployment keys were written to the private output directory. Services have not been activated. Read handoff.json before deployment.",
  );
} catch {
  console.error(
    "Restore failed. Check input, passphrase, connectivity, PostgreSQL 17 client/server versions and empty destination schemas. Inspect the destination before retrying; no services were activated.",
  );
  process.exitCode = 1;
}
