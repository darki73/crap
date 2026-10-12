import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const local = path.join(root, ".local-panel");
const env = path.join(local, ".env");
const config = path.join(local, "runtime/config.yaml");
if (existsSync(env) || existsSync(config)) {
  if (!existsSync(env) || !existsSync(config)) {
    throw new Error(
      "Incomplete local configuration. Restore both .local-panel/.env and runtime/config.yaml before continuing.",
    );
  }
  console.log("Existing local configuration preserved.");
} else {
  mkdirSync(path.dirname(config), { recursive: true });
  const adminKey = randomBytes(32).toString("hex");
  const clientKey = `cpa-${randomBytes(24).toString("hex")}`;
  writeFileSync(env, `PANEL_MANAGEMENT_KEY=${adminKey}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(
    config,
    `config-version: 8
server:
  host: "0.0.0.0"
  port: 8317
management:
  allow-remote: true
  secret-key: "${adminKey}"
  disable-control-panel: true
access:
  api-keys:
    - "${clientKey}"
oauth:
  auth-dir: "~/.cli-proxy-api"
routing:
  strategy: "round-robin"
  retry:
    request-retry: 3
observability:
  logs:
    logging-to-file: true
    logs-max-total-size-mb: 50
    debug: false
  usage:
    usage-statistics-enabled: true
`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created isolated local configuration with random keys. No providers configured.",
  );
}
