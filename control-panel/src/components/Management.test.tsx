import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { OperationDialog } from "./Management";
import { AccountActions } from "./AccountActions";
import { AdvancedConfiguration as Configuration } from "@/pages/AdvancedConfiguration";
import * as client from "@/lib/api";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("does not run a destructive operation until confirmed", async () => {
  const run = vi.fn(async () => {});
  const close = vi.fn();
  render(
    <OperationDialog
      operation={{
        title: "Delete test",
        description: "Delete a test fixture",
        destructive: true,
        confirm: "Delete now",
        run,
      }}
      onClose={close}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "Delete now" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete now" }));
  await waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(close).toHaveBeenCalledOnce();
});

it("keeps a failed operation open and preserves the edited input", async () => {
  const close = vi.fn();
  render(
    <OperationDialog
      operation={{
        title: "Edit",
        description: "Patch a field",
        initial: "{}",
        run: async () => {
          throw new Error("Rejected");
        },
      }}
      onClose={close}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: '{"label":"test"}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
  expect(await screen.findByText("Rejected")).toBeTruthy();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(
    "test",
  );
  expect(close).not.toHaveBeenCalled();
});

it("targets one account for status changes and masks its identity", async () => {
  const write = vi.spyOn(client, "write").mockResolvedValue({ status: "ok" });
  const saved = vi.fn(async () => {});
  const { container } = render(
    <AccountActions
      credential={{
        id: "one",
        name: "account.json",
        email: "private@example.com",
        provider: "claude",
        auth_index: "index-one",
        disabled: false,
      }}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  expect(container.innerHTML).not.toContain("private@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Disable account" }));
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith("/credentials/status", "PATCH", {
      name: "account.json",
      auth_index: "index-one",
      disabled: true,
    }),
  );
  expect(saved).toHaveBeenCalled();
});

it("blocks configuration writes when another editor changed the section", async () => {
  const api = vi
    .spyOn(client, "apiResponse")
    .mockResolvedValueOnce(new Response('{"strategy":"round-robin"}'))
    .mockResolvedValueOnce(new Response('{"strategy":"fill-first"}'));
  render(<Configuration onSaved={vi.fn(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Load configuration" }));
  const editor = await screen.findByRole("textbox", {
    name: "Configuration editor",
  });
  fireEvent.change(editor, {
    target: { value: '{"strategy":"weighted-round-robin"}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByText(/Configuration changed since loading/),
  ).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(2);
});

it("creates a missing configuration section without treating it as a failed connection", async () => {
  const missing = () => new client.APIError(404, "not found");
  const api = vi
    .spyOn(client, "apiResponse")
    .mockRejectedValueOnce(missing())
    .mockRejectedValueOnce(missing())
    .mockResolvedValueOnce(new Response("{}"));
  const saved = vi.fn(async () => {});
  render(<Configuration onSaved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Load configuration" }));
  expect(
    await screen.findByText(/This section is not configured yet/),
  ).toBeTruthy();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Configuration editor" }),
    { target: { value: '{"strategy":"round-robin"}' } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(api).toHaveBeenLastCalledWith(
    "/config/routing",
    expect.objectContaining({
      method: "PUT",
      body: '{"strategy":"round-robin"}',
    }),
  );
});
