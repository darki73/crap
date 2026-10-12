import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Models } from "./Models";
import * as apiModule from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const credentials = [
  { id: "one", name: "one.json", provider: "claude", disabled: false },
];

it("loads the selected account automatically and explains empty search results", async () => {
  const reader = vi.spyOn(apiModule, "api").mockResolvedValue({
    models: [{ id: "test-model", display_name: "Test model" }],
  });
  render(<Models credentials={credentials} />);
  expect(
    await screen.findByRole("heading", { name: "test-model" }),
  ).toBeTruthy();
  expect(reader).toHaveBeenCalledWith(
    "/credentials/models?name=one.json",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), {
    target: { value: "missing" },
  });
  expect(screen.getByText("No matching models")).toBeTruthy();
});

it("ignores a stale model response when the connected account changes", async () => {
  let finish!: (value: unknown) => void;
  const reader = vi.spyOn(apiModule, "api").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Models credentials={credentials} />);
  reader.mockResolvedValue({ models: [{ id: "new-account-model" }] });
  view.rerender(
    <Models
      credentials={[{ ...credentials[0], id: "two", name: "two.json" }]}
    />,
  );
  await screen.findByRole("heading", { name: "new-account-model" });
  await act(async () => {
    finish({ models: [{ id: "stale-model" }] });
  });
  expect(screen.queryByRole("heading", { name: "stale-model" })).toBeNull();
  expect(
    screen.getByRole("heading", { name: "new-account-model" }),
  ).toBeTruthy();
});
