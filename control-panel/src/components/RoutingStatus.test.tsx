import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoutingStatus } from "./RoutingStatus";
import * as apiModule from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const status = (mode: string, registered = true, age = 0) => ({
  policy: { mode },
  pluginRegistered: registered,
  plugins: [{ seen_at: new Date(Date.now() - age).toISOString() }],
});
it.each([true, false])(
  "strict routing never advertises a round-robin fallback",
  async (registered) => {
    vi.spyOn(apiModule, "api").mockResolvedValue({
      ...status("shadow", registered),
      strictRouting: true,
    });
    render(
      <RoutingStatus fallback="round-robin" connected onOpen={() => {}} />,
    );
    await screen.findByRole("button", {
      name: registered
        ? "Strict affinity · Claude Code"
        : "Strict routing unavailable",
    });
    expect(screen.queryByText(/round-robin/)).toBeNull();
  },
);
it("shows live affinity as primary and the configured strategy as fallback", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue(status("live"));
  const open = vi.fn();
  render(<RoutingStatus fallback="round-robin" connected onOpen={open} />);
  const badge = await screen.findByRole("button", {
    name: "Affinity routing · Live",
  });
  expect(screen.getByText(/Fallback: round-robin/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "round-robin routing" }),
  ).toBeNull();
  fireEvent.click(badge);
  expect(open).toHaveBeenCalledOnce();
});
it("keeps the built-in strategy primary when affinity only observes", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue(status("shadow"));
  render(<RoutingStatus fallback="round-robin" connected onOpen={() => {}} />);
  expect(
    await screen.findByText("Affinity in shadow mode · Observing only"),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "round-robin routing" }),
  ).toBeTruthy();
});
it.each([
  [status("live", false), "round-robin routing"],
  [status("live", true, 60000), "Affinity health unconfirmed"],
])(
  "does not advertise live selection without registration and a fresh heartbeat",
  async (state, title) => {
    vi.spyOn(apiModule, "api").mockResolvedValue(state);
    render(
      <RoutingStatus fallback="round-robin" connected onOpen={() => {}} />,
    );
    expect(
      await screen.findByRole("button", { name: title as string }),
    ).toBeTruthy();
    expect(screen.queryByText("Affinity routing · Live")).toBeNull();
  },
);
it("clearly marks unavailable status instead of claiming the fallback is active", async () => {
  vi.spyOn(apiModule, "api").mockRejectedValue(new Error("offline"));
  render(<RoutingStatus fallback="round-robin" connected onOpen={() => {}} />);
  expect(await screen.findByText("Routing status unavailable")).toBeTruthy();
});
