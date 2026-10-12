import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
      process.platform === "win32" ? "database-helper.exe" : "database-helper",
    ),
    "./control-panel/database-helper",
  ],
  { cwd: root },
);
console.log("Database setup helper is ready.");
