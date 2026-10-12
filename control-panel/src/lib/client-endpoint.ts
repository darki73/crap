import { useEffect, useState } from "react";
import { api } from "./api";

export type EndpointStatus = {
  localApiOrigin?: string;
  lanAccess?: { enabled: boolean; dashboardOrigin: string; apiOrigin: string };
  tailscale: { enabled: boolean; api: boolean; phase: string; apiUrl?: string };
};
export type ClientEndpoint = {
  origin: string | null;
  openAI: string | null;
  label: string;
  detail: string;
};
export function resolveClientEndpoint(
  status: EndpointStatus,
  hostname: string,
): ClientEndpoint {
  const tail = status.tailscale;
  const lan = status.lanAccess;
  if (lan?.enabled) {
    try {
      const dashboard = new URL(lan.dashboardOrigin),
        api = new URL(lan.apiOrigin);
      const valid = [dashboard, api].every(
        (u) =>
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          u.pathname === "/" &&
          !u.search &&
          !u.hash,
      );
      if (
        valid &&
        (dashboard.hostname === hostname ||
          !(tail.enabled && tail.api && tail.phase === "online"))
      ) {
        return {
          origin: api.origin,
          openAI: `${api.origin}/v1`,
          label: "LAN access",
          detail:
            "Use this address on your trusted network. The crap shell checks LAN reachability before launch and uses Tailscale when configured and needed.",
        };
      }
    } catch {
      /* Invalid settings must not become a client destination. */
    }
  }
  if (tail.enabled && tail.api) {
    if (tail.phase === "online" && tail.apiUrl) {
      try {
        const url = new URL(tail.apiUrl);
        if (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          url.hostname.endsWith(".ts.net") &&
          url.port === "8443" &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        )
          return {
            origin: url.origin,
            openAI: `${url.origin}/v1`,
            label: "Tailscale",
            detail:
              "Connect through Tailscale using an allowed login and a client API key.",
          };
      } catch {
        /* Wait for a valid address from the gateway. */
      }
    }
    return {
      origin: null,
      openAI: null,
      label: "Tailscale unavailable",
      detail:
        "Inference access is enabled, but the private gateway is not online. Check Tailscale in Setup & Integrations.",
    };
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    let origin: string;
    try {
      const local = new URL(status.localApiOrigin || "http://localhost:8317");
      if (
        local.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
        local.username ||
        local.password ||
        local.pathname !== "/" ||
        local.search ||
        local.hash
      )
        throw new Error();
      origin = local.origin;
    } catch {
      return {
        origin: null,
        openAI: null,
        label: "Local address unavailable",
        detail: "Check the deployment's local client API address.",
      };
    }
    return {
      origin,
      openAI: `${origin}/v1`,
      label: "Local access",
      detail:
        "For clients on the proxy machine. Enable Tailscale inference access to connect other devices.",
    };
  }
  return {
    origin: null,
    openAI: null,
    label: "Remote inference unavailable",
    detail:
      "Enable Inference API in Tailscale settings to connect clients from this device.",
  };
}

export function useClientEndpoint() {
  const [endpoint, setEndpoint] = useState<ClientEndpoint>({
    origin: null,
    openAI: null,
    label: "Checking client access…",
    detail: "",
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const status = await api<EndpointStatus>("/integrations");
        if (active)
          setEndpoint(resolveClientEndpoint(status, window.location.hostname));
      } catch {
        if (active)
          setEndpoint({
            origin: null,
            openAI: null,
            label: "Client access unavailable",
            detail:
              "Could not check the current connection settings. Retrying automatically.",
          });
      }
      if (active) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return endpoint;
}
