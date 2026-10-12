import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { UsagePage } from "./Usage";
import { averageWindow } from "@/lib/accounts";
import * as apiModule from "@/lib/api";
import type { Credential } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("updates quota observations without forcing provider refreshes, pauses when hidden and stops on unmount", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const reader = vi.spyOn(apiModule, "api").mockResolvedValue({
    windows: [{ label: "Weekly window", used: 20 }],
    checkedAt: Date.now(),
  });
  const view = render(
    <UsagePage
      {...props}
      credentials={[{ ...codex, provider: "claude", auth_index: "one" }]}
    />,
  );
  await act(async () => {});
  expect(screen.getByText("80% left")).toBeTruthy();
  reader.mockResolvedValue({
    windows: [{ label: "Weekly window", used: 30 }],
    checkedAt: Date.now(),
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.getByText("70% left")).toBeTruthy();
  expect(reader).toHaveBeenCalledTimes(2);
  expect(
    reader.mock.calls.every(
      ([path]) => path === "/accounts/usage?auth_index=one",
    ),
  ).toBe(true);
  hidden.mockReturnValue(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(reader).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(reader).toHaveBeenCalledTimes(3);
  view.unmount();
  await vi.advanceTimersByTimeAsync(30000);
  expect(reader).toHaveBeenCalledTimes(3);
});

it("does not overlap background quota reads and retains prior values after a failed read", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const reader = vi.spyOn(apiModule, "api").mockResolvedValue({
    windows: [{ label: "Weekly window", used: 20 }],
    checkedAt: Date.now(),
  });
  render(
    <UsagePage
      {...props}
      credentials={[{ ...codex, provider: "claude", auth_index: "one" }]}
    />,
  );
  await act(async () => {});
  let reject!: (error: Error) => void;
  reader.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45000);
  });
  expect(reader).toHaveBeenCalledTimes(2);
  await act(async () => {
    reject(new Error("Lookup unavailable"));
  });
  expect(screen.getByText("80% left")).toBeTruthy();
  expect(screen.getByText(/Lookup unavailable/)).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.queryByText(/Lookup unavailable/)).toBeNull();
});
const codex: Credential = {
  id: "codex",
  name: "codex-file",
  email: "alice@example.com",
  provider: "codex",
  disabled: false,
  quota: {
    signals: {
      "x-codex-primary-used-percent": "20",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "40",
      "x-codex-secondary-window-minutes": "10080",
    },
  },
};
const props = {
  onConnect: vi.fn(),
  onRefresh: vi.fn(async () => {}),
  refreshing: false,
};

it("shows remaining allowances, switches to used, filters and masks identities", () => {
  const { container } = render(
    <UsagePage
      {...props}
      credentials={[
        codex,
        { id: "other", name: "other", provider: "xai", disabled: false },
      ]}
    />,
  );
  expect(screen.getByText("80% left")).toBeTruthy();
  expect(screen.getByText("60% left")).toBeTruthy();
  expect(container.innerHTML).not.toContain("alice@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Used" }));
  expect(screen.getByText("20% used")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /xAI/ }));
  expect(screen.queryByText("a•••@e•••")).toBeNull();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search usage accounts" }),
    { target: { value: "absent" } },
  );
  expect(screen.getByText("No matching accounts")).toBeTruthy();
});

it("loads Claude account-wide data and refreshes through the page action", async () => {
  const refresh = vi.fn(async () => {});
  vi.spyOn(apiModule, "api").mockResolvedValue({
    windows: [
      { label: "5-hour window", used: 1 },
      { label: "Weekly window", used: 0 },
    ],
    checkedAt: Date.now(),
    plan: "Pro",
  });
  render(
    <UsagePage
      {...props}
      onRefresh={refresh}
      credentials={[
        {
          ...codex,
          id: "claude",
          provider: "claude",
          auth_index: "one",
          quota: undefined,
        },
      ]}
    />,
  );
  expect(await screen.findByText("99% left")).toBeTruthy();
  expect(screen.getByText("Pro")).toBeTruthy();
  expect(screen.getByText("Account-wide usage")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(refresh).toHaveBeenCalledOnce();
});

it("refreshes a subscription upgrade through the explicit plan action", async () => {
  const reader = vi.spyOn(apiModule, "api").mockImplementation(
    async (path) =>
      ({
        windows: [{ label: "Weekly window", used: 1 }],
        checkedAt: Date.now(),
        plan: path.includes("refresh_plan=1") ? "Max 20×" : "Pro",
      }) as never,
  );
  render(
    <UsagePage
      {...props}
      credentials={[
        {
          ...codex,
          provider: "claude",
          auth_index: "upgraded",
          quota: undefined,
        },
      ]}
    />,
  );
  await screen.findByText("Pro");
  fireEvent.click(screen.getByRole("button", { name: "Refresh plans" }));
  await screen.findByText("Max 20×");
  expect(reader).toHaveBeenCalledWith(
    "/accounts/usage?auth_index=upgraded&refresh_plan=1",
  );
});

it("excludes disabled and unknown accounts from summary averages", () => {
  render(
    <UsagePage
      {...props}
      credentials={[
        codex,
        { ...codex, id: "disabled", disabled: true },
        { ...codex, id: "unknown", quota: undefined },
      ]}
    />,
  );
  expect(
    screen.getByText("1 of 3 accounts included · equal account weighting"),
  ).toBeTruthy();
  expect(
    averageWindow(
      [undefined, { label: "Weekly", used: 0 }, { label: "Weekly" }],
      true,
    ),
  ).toEqual({ percent: 100, count: 1 });
  expect(averageWindow([undefined], true)).toEqual({
    percent: undefined,
    count: 0,
  });
});
