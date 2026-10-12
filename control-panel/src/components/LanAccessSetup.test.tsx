import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LanAccessSetup } from "./LanAccessSetup";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads saved LAN addresses and saves only explicit settings behind the panel API boundary", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      lanAccess: { enabled: false, dashboardOrigin: "", apiOrigin: "" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<LanAccessSetup />);
  fireEvent.click(screen.getByRole("button", { name: "LAN Connection" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save LAN Connection" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Prefer LAN access" }));
  fireEvent.change(screen.getByLabelText("LAN dashboard origin"), {
    target: { value: "https://panel.example.com" },
  });
  fireEvent.change(screen.getByLabelText(/LAN API origin/), {
    target: { value: "https://panel.example.com" },
  });
  fetcher.mockResolvedValue(Response.json({}));
  fireEvent.click(screen.getByRole("button", { name: "Save LAN Connection" }));
  await screen.findByRole("status");
  const [url, options] = fetcher.mock.calls.at(-1)!;
  expect(url).toBe("/api/integrations/lan/configure");
  expect(JSON.parse(options.body)).toEqual({
    enabled: true,
    dashboardOrigin: "https://panel.example.com",
    apiOrigin: "https://panel.example.com",
  });
  expect(options.headers.get("X-Panel-Client")).toBe("cliproxy-panel");
});
