import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Configuration } from "./Configuration";
import { ConfigField } from "@/components/ConfigFields";
import {
  configSchema,
  configSections,
  type ConfigValue,
} from "@/lib/configuration";
import * as client from "@/lib/api";
import { useState } from "react";

beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows defaults for an absent section without writing them", async () => {
  vi.spyOn(client, "api").mockRejectedValue(
    new client.APIError(404, "not found"),
  );
  const write = vi.spyOn(client, "write").mockResolvedValue({});
  render(<Configuration onSaved={vi.fn(async () => {})} />);
  const strategy = await screen.findByRole("combobox", {
    name: "Routing strategy",
  });
  expect((strategy as HTMLSelectElement).value).toBe('"round-robin"');
  expect(
    screen
      .getByRole("switch", { name: "Session affinity subagents" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Session retention",
      }) as HTMLInputElement
    ).value,
  ).toBe("1h");
  expect(
    (screen.getByRole("button", { name: "Review & save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(write).not.toHaveBeenCalled();
});

it("saves typed edits while preserving unknown fields and omitted defaults", async () => {
  const original = {
    strategy: "round-robin",
    retry: { "request-retry": 3, "future-option": 9 },
  };
  vi.spyOn(client, "api").mockImplementation(async () =>
    structuredClone(original),
  );
  const write = vi.spyOn(client, "write").mockResolvedValue({});
  render(<Configuration onSaved={vi.fn(async () => {})} />);
  fireEvent.change(
    await screen.findByRole("spinbutton", { name: "Request retries" }),
    { target: { value: "0" } },
  );
  expect(
    (
      screen.getByRole("tab", {
        name: "Requests",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith("/config/routing", "PUT", {
      strategy: "round-robin",
      retry: { "request-retry": 0, "future-option": 9 },
    }),
  );
});

it("blocks stale form saves and retains the user's edit", async () => {
  vi.spyOn(client, "api")
    .mockResolvedValueOnce({ strategy: "round-robin" })
    .mockResolvedValueOnce({ strategy: "fill-first" });
  const write = vi.spyOn(client, "write").mockResolvedValue({});
  render(<Configuration onSaved={vi.fn(async () => {})} />);
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Routing strategy" }),
    { target: { value: '"weighted-round-robin"' } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByText(/Configuration changed since loading/),
  ).toBeTruthy();
  expect(write).not.toHaveBeenCalled();
});

it("removes an override to restore the default while retaining siblings", async () => {
  vi.spyOn(client, "api").mockResolvedValue({
    retry: { "request-retry": 8, "max-retry-interval": 17 },
  });
  const write = vi.spyOn(client, "write").mockResolvedValue({});
  render(<Configuration onSaved={vi.fn(async () => {})} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Use default for routing.retry.request-retry",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith("/config/routing", "PUT", {
      retry: { "max-retry-interval": 17 },
    }),
  );
});

it("keeps all canonical sections represented, including nested rules and provider fields", () => {
  expect(configSections.map(([key]) => key).sort()).toEqual(
    Object.keys(configSchema.properties!).sort(),
  );
  expect(
    configSchema.properties!.requests.properties!.payload.properties!.override
      .item!.properties!.params.additional!.kind,
  ).toBe("any");
  expect(
    configSchema.properties!["api-keys"].properties!.claude.item!.properties!
      .keys.item!.properties!["api-key"].kind,
  ).toBe("string");
});

it("edits typed list entries and prevents edits to server-owned revisions", () => {
  function Fixture() {
    const [value, setValue] = useState<ConfigValue>([]);
    return (
      <>
        <ConfigField
          schema={{
            kind: "array",
            item: {
              kind: "object",
              properties: {
                enabled: { kind: "boolean", default: false },
                count: { kind: "number", default: 0 },
              },
            },
          }}
          value={value}
          onChange={(next) => setValue(next!)}
          path="example"
          label="Rules"
        />
        <output data-testid="result">{JSON.stringify(value)}</output>
      </>
    );
  }
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Add rules entry" }));
  fireEvent.click(screen.getByText("Entry 1"));
  fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Count" }), {
    target: { value: "4" },
  });
  expect(screen.getByTestId("result").textContent).toBe(
    '[{"enabled":true,"count":4}]',
  );
  const change = vi.fn();
  const { container } = render(
    <ConfigField
      schema={{ kind: "number", default: 0 }}
      path="plugins.auth-revision"
      label="Auth revision"
      value={3}
      onChange={change}
    />,
  );
  expect(
    (within(container).getByRole("spinbutton") as HTMLInputElement).disabled,
  ).toBe(true);
});
