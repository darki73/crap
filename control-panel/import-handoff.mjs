// Restore a logical workspace without silently activating duplicate notification
// workers or a different Tailscale identity. The owner reconnects from Setup.
export async function prepareImportedIntegrations(store, id) {
  if (!id) return;
  if (!/^[a-f0-9]{12}$/.test(id))
    throw new Error("Invalid workspace handoff identity.");
  const document = await store.load();
  if (document.data.deploymentHandoff === id) return;
  document.data.tailscale = { ...document.data.tailscale, enabled: false };
  document.data.telegram = { ...document.data.telegram, enabled: false };
  document.data.pair = null;
  document.data.dashboardAddress = "";
  document.data.deploymentHandoff = id;
  await store.save(document);
}
