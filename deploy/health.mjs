import { readFile } from "node:fs/promises";
// Health output never includes upstream bodies, account names or credentials.
try {
  const env = Object.fromEntries(
    (await readFile("/run/crap/service.env", "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  const upstream = process.env.PROXY_URL || "http://proxy:8317";
  const plugins = await fetch(`${upstream}/v8/management/plugins`, {
    headers: { Authorization: `Bearer ${env.MANAGEMENT_KEY}` },
    redirect: "error",
  });
  if (
    !plugins.ok ||
    !(await plugins.json()).plugins?.some(
      (p) => p.id === "affinity-router" && p.registered && p.effective_enabled,
    )
  )
    throw new Error();
  if (
    !(await fetch(`${env.AFFINITY_CONTROL_URL}/healthz`, { redirect: "error" }))
      .ok
  )
    throw new Error();
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT || 3000}/`,
    { headers: { Host: "localhost:3000" }, redirect: "error" },
  );
  if (!response.ok) throw new Error();
  const panelHealth = await fetch(
    `http://127.0.0.1:${process.env.PORT || 3000}/api/health`,
    {
      headers: { Host: "localhost:3000", "X-Panel-Client": "cliproxy-panel" },
      redirect: "error",
    },
  );
  if (!panelHealth.ok || (await panelHealth.json()).status !== "ok")
    throw new Error();
  if (!(await fetch("http://gateway:8319/readyz", { redirect: "error" })).ok)
    throw new Error();
  console.log("CRAP ready: panel, database, proxy and plugin.");
} catch {
  console.error(
    "CRAP not ready: check panel, control, database and plugin health.",
  );
  process.exitCode = 1;
}
