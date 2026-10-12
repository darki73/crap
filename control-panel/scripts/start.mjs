import { fileURLToPath } from "node:url";
import { createPanelServer } from "../server.mjs";
import { createAccountUsageReader } from "../account-usage.mjs";
import { startQuotaCollector } from "../affinity.mjs";
import { quotaAdmissionFromEnvironment } from "../quota-admission.mjs";
import { prepareImportedIntegrations } from "../import-handoff.mjs";
import {
  createIntegrationStore,
  createIntegrations,
  createTailnetRuntime,
} from "../integrations.mjs";
const port = Number(process.env.PORT || 3000),
  upstream = process.env.PROXY_URL || "http://127.0.0.1:8317";
const root =
  process.env.PANEL_WORKSPACE_ROOT ||
  fileURLToPath(new URL("../../", import.meta.url));
if (process.env.PANEL_IMPORT_ID) {
  await prepareImportedIntegrations(
    createIntegrationStore({
      url: process.env.AFFINITY_CONTROL_URL,
      token: process.env.AFFINITY_CONTROL_TOKEN,
      key: process.env.AFFINITY_ID_KEY,
    }),
    process.env.PANEL_IMPORT_ID,
  );
}
const integrations =
  process.env.AFFINITY_CONTROL_URL &&
  process.env.AFFINITY_CONTROL_TOKEN &&
  process.env.AFFINITY_ID_KEY
    ? createIntegrations({
        identityKey: process.env.AFFINITY_ID_KEY,
        store: createIntegrationStore({
          url: process.env.AFFINITY_CONTROL_URL,
          token: process.env.AFFINITY_CONTROL_TOKEN,
          key: process.env.AFFINITY_ID_KEY,
        }),
        tailnet: createTailnetRuntime({
          root,
          panelURL: `http://127.0.0.1:${port}`,
          proxyURL: process.env.INFERENCE_PROXY_URL || upstream,
          executable: process.env.TAILNET_GATEWAY_PATH,
        }),
        managementKey: process.env.MANAGEMENT_KEY,
        upstream,
      })
    : undefined;
const readAccountUsage = createAccountUsageReader({
  upstreamURL: new URL(upstream),
  managementKey: process.env.MANAGEMENT_KEY,
  quotaAdmission: quotaAdmissionFromEnvironment({
    url: process.env.AFFINITY_CONTROL_URL,
    token: process.env.AFFINITY_CONTROL_TOKEN,
    key: process.env.AFFINITY_ID_KEY,
  }),
});
const stopCollector = integrations
  ? startQuotaCollector({
      upstream,
      managementKey: process.env.MANAGEMENT_KEY,
      controlURL: process.env.AFFINITY_CONTROL_URL,
      token: process.env.AFFINITY_CONTROL_TOKEN,
      readUsage: readAccountUsage,
    })
  : () => {};
const server = createPanelServer({
  accountUsageReader: readAccountUsage,
  upstream,
  inferenceURL: process.env.INFERENCE_PROXY_URL,
  managementKey: process.env.MANAGEMENT_KEY,
  origins: (
    process.env.PANEL_ORIGINS ||
    `http://localhost:${port},http://127.0.0.1:${port}`
  ).split(","),
  integrations,
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, process.env.HOST || "127.0.0.1", resolve);
});
integrations?.start();
console.log(
  `Control room listening on port ${port}. Integrations ${integrations ? "available" : "require affinity control configuration"}.`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    stopCollector();
    await integrations?.stop();
    server.closeAllConnections();
    server.close();
  });
