import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPrivate } from "../database.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const strict = existsSync(path.join(root, ".local-panel/strict/active.json"));
try {
  const transfer = JSON.parse(
    await readFile(
      path.join(root, ".local-panel/database/transfers/state.json"),
      "utf8",
    ),
  );
  if (
    transfer.sourcePaused ||
    !["idle", "failed", "complete"].includes(transfer.phase)
  )
    throw new Error(
      "Resolve the database transfer in Setup before starting the source proxy.",
    );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let state;
try {
  state = JSON.parse(
    await readFile(path.join(root, ".local-panel/database/state.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT")
    throw new Error("Cannot read database setup state.");
}
if (state && !["active", "failed", "idle"].includes(state.phase))
  throw new Error(
    "Resolve the interrupted database setup before restarting the proxy.",
  );
await runPrivate("docker", [
  "compose",
  "--project-directory",
  root,
  "--env-file",
  path.join(root, ".local-panel/.env"),
  "-f",
  path.join(root, "docker-compose.panel.yml"),
  ...(state?.phase === "active"
    ? ["-f", path.join(root, ".local-panel/database/compose.json")]
    : []),
  ...(strict ? ["-f", path.join(root, "deploy/local.strict.yaml")] : []),
  ...(existsSync(path.join(root, ".local-panel/strict/images.json"))
    ? ["-f", path.join(root, ".local-panel/strict/images.json")]
    : []),
  "up",
  "-d",
  "--no-deps",
  "--no-build",
  "proxy",
  ...(strict ? ["control", "gateway"] : []),
]);
console.log("Local proxy started with the saved database configuration.");
