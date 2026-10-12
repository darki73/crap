import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runPrivate } from "../database.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(path.join(root, ".local-panel"), { recursive: true });
await runPrivate(
  "go",
  [
    "build",
    "-o",
    path.join(
      root,
      ".local-panel",
      process.platform === "win32" ? "tailnet-gateway.exe" : "tailnet-gateway",
    ),
    ".",
  ],
  { cwd: path.join(root, "control-panel/tailnet-gateway") },
);
console.log("Embedded Tailscale gateway built. No device was enrolled.");
