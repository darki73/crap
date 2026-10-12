import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { resolveClientEndpoint } from "./client-endpoint";
import { ClientEndpoints } from "@/components/ClientEndpoints";
import * as apiModule from "./api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const online = {
  tailscale: {
    enabled: true,
    api: true,
    phase: "online",
    apiUrl: "https://crap.example.ts.net:8443",
  },
};
it("uses a configured local deployment port and rejects unsafe local origins", () => {
  const status = {
    tailscale: { ...online.tailscale, enabled: false },
    localApiOrigin: "http://localhost:18317",
  };
  expect(resolveClientEndpoint(status, "localhost").openAI).toBe(
    "http://localhost:18317/v1",
  );
  expect(
    resolveClientEndpoint(
      { ...status, localApiOrigin: "http://user:secret@localhost:18317" },
      "localhost",
    ).origin,
  ).toBeNull();
  expect(resolveClientEndpoint(status, "remote.example").origin).toBeNull();
});
it("uses the live inference origin for Claude and appends /v1 only for OpenAI", () => {
  for (const hostname of ["localhost", "127.0.0.1", "crap.example.ts.net"]) {
    expect(resolveClientEndpoint(online, hostname)).toMatchObject({
      origin: online.tailscale.apiUrl,
      openAI: `${online.tailscale.apiUrl}/v1`,
      label: "Tailscale",
    });
  }
});
it("never substitutes localhost for an offline private gateway or a remote dashboard-only session", () => {
  expect(
    resolveClientEndpoint(
      { tailscale: { ...online.tailscale, phase: "disconnected" } },
      "localhost",
    ).openAI,
  ).toBeNull();
  const dashboardOnly = { tailscale: { ...online.tailscale, api: false } };
  expect(
    resolveClientEndpoint(dashboardOnly, "crap.example.ts.net").openAI,
  ).toBeNull();
  expect(resolveClientEndpoint(dashboardOnly, "localhost").openAI).toBe(
    "http://localhost:8317/v1",
  );
  expect(
    resolveClientEndpoint(
      { tailscale: { ...online.tailscale, enabled: false } },
      "localhost",
    ).label,
  ).toBe("Local access");
});
it("rejects malformed or credential-bearing runtime addresses", () => {
  for (const apiUrl of [
    "https://user:secret@crap.example.ts.net:8443",
    "https://crap.example.ts.net",
    "http://crap.example.ts.net:8443",
    "https://crap.example.ts.net:8443/v1",
    "not-a-url",
  ]) {
    expect(
      resolveClientEndpoint(
        { tailscale: { ...online.tailscale, apiUrl } },
        "localhost",
      ).origin,
    ).toBeNull();
  }
});
it("shows and copies the live URLs for each client", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue(online);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ClientEndpoints />);
  await screen.findByText(`${online.tailscale.apiUrl}/v1`);
  fireEvent.click(screen.getByRole("button", { name: "Copy OpenAI base URL" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(`${online.tailscale.apiUrl}/v1`),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy Claude base URL" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(online.tailscale.apiUrl),
  );
  expect(screen.queryByText(/localhost:8317/)).toBeNull();
});
it("does not offer a stale or guessed URL if status cannot be loaded", async () => {
  vi.spyOn(apiModule, "api").mockRejectedValue(new Error("offline"));
  render(<ClientEndpoints />);
  await screen.findByText("Client access unavailable");
  expect(
    screen.queryByRole("button", { name: "Copy OpenAI base URL" }),
  ).toBeNull();
});
