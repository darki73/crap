import { createServer } from "vite";
import { createPanelServer } from "../server.mjs";
import { startQuotaCollector } from "../affinity.mjs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createLocalDatabaseManager } from "../database.mjs";
import { createDatabaseTransfer } from "../database-transfer.mjs";
import { createAccountUsageReader } from "../account-usage.mjs";
import { quotaAdmissionFromEnvironment } from "../quota-admission.mjs";
import {
  createIntegrations,
  createIntegrationStore,
  createTailnetRuntime,
} from "../integrations.mjs";

try {
  loadEnvFile(new URL("../../.local-panel/affinity.env", import.meta.url));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  loadEnvFile(new URL("../../.local-panel/strict/dev.env", import.meta.url));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const managementURL = process.env.PROXY_URL || "http://127.0.0.1:8317";
const inferenceURL =
  process.env.INFERENCE_PROXY_URL ||
  (process.env.CRAP_STRICT_INTERNAL_URL ? "http://127.0.0.1:8317" : undefined);
const readAccountUsage = createAccountUsageReader({
  quotaAdmission: quotaAdmissionFromEnvironment({
    url: process.env.AFFINITY_CONTROL_URL,
    token: process.env.AFFINITY_CONTROL_TOKEN,
    key: process.env.AFFINITY_ID_KEY,
  }),
  upstreamURL: new URL(managementURL),
  managementKey: process.env.PANEL_MANAGEMENT_KEY,
  cacheFile: new URL("../../.local-panel/quota-cache.json", import.meta.url),
});
const stopCollector = process.env.AFFINITY_CONTROL_TOKEN
  ? startQuotaCollector({
      upstream: managementURL,
      managementKey: process.env.PANEL_MANAGEMENT_KEY,
      controlURL: process.env.AFFINITY_CONTROL_URL,
      token: process.env.AFFINITY_CONTROL_TOKEN,
      readUsage: readAccountUsage,
    })
  : () => {};

const integrations = createIntegrations({
  upstream: managementURL,
  identityKey: process.env.AFFINITY_ID_KEY,
  store: createIntegrationStore({
    url: process.env.AFFINITY_CONTROL_URL,
    token: process.env.AFFINITY_CONTROL_TOKEN,
    key: process.env.AFFINITY_ID_KEY,
  }),
  tailnet: createTailnetRuntime({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    proxyURL: inferenceURL || managementURL,
  }),
  managementKey: process.env.PANEL_MANAGEMENT_KEY,
});
const bridge = createPanelServer({
  integrations,
  databaseTransfer: createDatabaseTransfer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
  }),
  databaseManager: createLocalDatabaseManager({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    managementKey: process.env.PANEL_MANAGEMENT_KEY,
  }),
  upstream: managementURL,
  inferenceURL,
  managementKey: process.env.PANEL_MANAGEMENT_KEY,
  accountUsageReader: readAccountUsage,
  origins: [
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ],
});
await new Promise((resolve, reject) => {
  bridge.once("error", reject);
  bridge.listen(3001, "127.0.0.1", resolve);
});
try {
  const vite = await createServer();
  await vite.listen();
  integrations.start();
  vite.printUrls();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      stopCollector();
      await integrations.stop();
      await vite.close();
      bridge.closeAllConnections();
      bridge.close();
    });
  }
} catch (error) {
  bridge.close();
  throw error;
}
