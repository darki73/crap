import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Affinity } from "./Affinity";
import * as apiModule from "@/lib/api";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const state = {
  policy: {
    version: 3,
    mode: "shadow",
    minimumRemaining: 5,
    freshnessSeconds: 300,
    affinitySeconds: 3600,
  },
  summary: {
    events: 0,
    reportedTokens: null,
    knownTotals: 0,
    complete: 0,
    failed: 0,
    cacheRead: null,
    cacheWrite: null,
  },
  journal: { admitted: 0, unresolved: 0, completed: 0 },
  plugins: [],
  quotas: [],
  decisions: [],
  groups: [],
  recent: [],
};
it("shows the strict reserve without obsolete legacy mode or expiry controls", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    ...state,
    strictRouting: true,
  });
  render(<Affinity view="routing" />);
  await screen.findByText("Stay together. Switch only when needed.");
  expect(screen.queryByLabelText("Affinity lifetime")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
  expect(screen.getByText("One request, one attempt")).toBeTruthy();
  expect(
    (screen.getByLabelText("Quota reserve (%)") as HTMLInputElement).value,
  ).toBe("5");
  expect(screen.getByRole("button", { name: "Save reserve" })).toBeTruthy();
});
it("shows observed delivery coverage without presenting it as complete billing", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    ...state,
    coverage: {
      matchedTraces: 3,
      completedWithoutUsage: 1,
      unlinkedJournal: 2,
      unlinkedUsage: 4,
    },
  });
  render(<Affinity view="ledger" />);
  await screen.findByText("Delivery coverage");
  expect(
    screen.getByText("Completed without usage").parentElement?.textContent,
  ).toContain("1");
  expect(
    screen.getByText(/cannot prove that every token was captured/),
  ).toBeTruthy();
});
it("preserves unknown totals and saves an explicit versioned policy change", async () => {
  const call = vi.spyOn(apiModule, "api").mockResolvedValue(state);
  render(<Affinity />);
  await screen.findByText("Observe only");
  expect(
    screen.getByText("Reported tokens").parentElement?.textContent,
  ).toContain("—");
  expect(call.mock.calls.every(([path]) => path === "/affinity/state")).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("Minimum remaining"), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  await waitFor(() =>
    expect(call.mock.calls.some(([path]) => path === "/affinity/policy")).toBe(
      true,
    ),
  );
  const [, options] = call.mock.calls.find(
    ([path]) => path === "/affinity/policy",
  )!;
  expect(JSON.parse(options?.body as string)).toMatchObject({
    version: 3,
    minimumRemaining: 12,
    mode: "shadow",
  });
  fireEvent.click(screen.getByRole("button", { name: "Token Ledger" }));
  expect(await screen.findByText(/No priced requests yet/)).toBeTruthy();
});

it("uses private account labels throughout quota, decisions and ledger views", async () => {
  const account_id = "v1:f00dcafefixture";
  const timestamp = "2026-10-05T12:00:00Z";
  vi.spyOn(apiModule, "api").mockResolvedValue({
    ...state,
    accountLabels: { [account_id]: "a•••@e•••" },
    quotas: [
      {
        account_id,
        provider: "claude",
        plan: "Pro",
        observed_at: timestamp,
        error: false,
        windows: [],
      },
    ],
    decisions: [
      {
        id: 1,
        account_id,
        decided_at: timestamp,
        mode: "shadow",
        model: "fixture",
        reason: "affinity",
        candidate_count: 1,
      },
    ],
    groups: [
      {
        account_id,
        provider: "claude",
        model: "fixture",
        service_tier: "",
        attempts: 1,
        tokens: "42",
        known_totals: 1,
      },
    ],
    recent: [
      {
        event_id: "fixture",
        account_id,
        provider: "claude",
        model: "fixture",
        started_at: timestamp,
        outcome: "succeeded",
        quality: "complete",
        reported_total: "42",
      },
    ],
  });
  render(<Affinity />);
  await screen.findAllByText("a•••@e•••");
  expect(screen.getAllByText("a•••@e•••")).toHaveLength(2);
  expect(screen.queryByText("Account f00dcafe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Token Ledger" }));
  expect(screen.getAllByText("a•••@e•••")).toHaveLength(2);
});

it("opens the ledger directly without duplicating the sidebar navigation", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue(state);
  const changeView = vi.fn();
  render(<Affinity view="ledger" onViewChange={changeView} />);
  expect(
    await screen.findByRole("heading", { name: "Token Ledger", level: 1 }),
  ).toBeTruthy();
  await screen.findByText(/No priced requests yet/);
  expect(screen.queryByText("Selection policy")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Routing & headroom" }),
  ).toBeNull();
  expect(changeView).not.toHaveBeenCalled();
});

it("shows unknown cache duration and legacy pricing assumptions", async () => {
  vi.spyOn(apiModule, "api").mockResolvedValue({
    ...state,
    cache: {
      fiveMinute: "3",
      oneHour: "2",
      unknownTokens: "10",
      unknownRequests: 1,
    },
    costs: [
      {
        kind: "api_equivalent",
        pricing_basis: "legacy_assumed",
        attempts: 1,
        usd: "0.1",
      },
    ],
  });
  render(<Affinity view="ledger" />);
  expect(await screen.findByText("Claude Cache Writes")).toBeTruthy();
  expect(screen.getByText(/1 requests have cache writes/)).toBeTruthy();
  expect(screen.getByText(/Legacy rate assumption/)).toBeTruthy();
});
