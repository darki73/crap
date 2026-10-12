import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PriceCatalog } from "./PriceCatalog";
import * as apiModule from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("saves both Claude durations without an aggregate assumption", async () => {
  const call = vi.spyOn(apiModule, "api").mockResolvedValue({ ok: true });
  render(
    <PriceCatalog prices={[]} onSaved={vi.fn().mockResolvedValue(undefined)} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add rate version" }));
  for (const [label, value] of [
    ["Exact reported model", "claude-fixture"],
    ["Uncached input / million", "4"],
    ["Cache reads / million", "0.2"],
    ["5-minute cache writes / million", "5"],
    ["1-hour cache writes / million", "8"],
    ["Output / million", "20"],
    ["Reasoning / million", "20"],
    ["Source and assumptions", "Synthetic rates"],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Save rate version" }));
  await waitFor(() => expect(call).toHaveBeenCalledOnce());
  const body = JSON.parse(call.mock.calls[0][1]!.body as string);
  expect(body.cacheWrite5mRate).toBe("5");
  expect(body.cacheWrite1hRate).toBe("8");
  expect(body).not.toHaveProperty("cacheWriteRate");
});

it("keeps generic provider rates separate from Claude durations", () => {
  render(<PriceCatalog prices={[]} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rate version" }));
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "codex" },
  });
  expect(screen.getByLabelText("Cache writes / million")).toBeTruthy();
  expect(screen.queryByLabelText("1-hour cache writes / million")).toBeNull();
});

it("labels old Claude rates as assumptions and displays integer prices correctly", () => {
  render(
    <PriceCatalog
      prices={[
        {
          id: 1,
          provider: "claude",
          model: "fixture",
          service_tier: "",
          effective_from: "2026-10-05",
          input_rate: "4",
          cache_read_rate: "0.2",
          cache_write_rate: "5",
          output_rate: "20",
          reasoning_rate: "20",
          note: "Old fixture",
        },
      ]}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByText(/Legacy duration assumption/)).toBeTruthy();
  expect(screen.getAllByText("$20")).toHaveLength(2);
});

it("searches all loaded rates and resets pagination for the result", () => {
  const prices = Array.from({ length: 45 }, (_, id) => ({
    id,
    provider: "claude",
    model: `fixture-model-${id}`,
    service_tier: "auto",
    effective_from: "2026-10-12",
    input_rate: "4",
    output_rate: "20",
    cache_read_rate: "0.2",
    cache_write_rate: null,
    reasoning_rate: "20",
    note: "Fixture",
  }));
  render(<PriceCatalog prices={prices} onSaved={vi.fn()} />);
  expect(screen.getAllByRole("row")).toHaveLength(11);
  fireEvent.click(screen.getByLabelText("Next rates page"));
  fireEvent.change(screen.getByLabelText("Search price catalog"), {
    target: { value: "fixture-model-44" },
  });
  expect(screen.getByText("claude / fixture-model-44")).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(screen.getByText("1–1 of 1 loaded")).toBeTruthy();
});
