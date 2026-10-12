import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClientShellSetup } from "./ClientShellSetup";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("offers maintained scripts and shell-specific instructions without embedding credentials", () => {
  render(
    <ClientShellSetup
      endpoint={{
        origin: "https://proxy.example.ts.net:8443",
        openAI: "https://proxy.example.ts.net:8443/v1",
        label: "Tailscale",
        detail: "Private access",
      }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Set Up the crap Command" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Configure this computer automatically",
    }),
  );
  expect(
    screen
      .getByRole("link", { name: "Download PowerShell installer" })
      .getAttribute("href"),
  ).toBe("/client-setup/crap.ps1");
  expect(screen.getByText(/Unblock-File -LiteralPath/)).toBeTruthy();
  expect(screen.getByText(/Unblock-File -LiteralPath/).textContent).toBe(
    "Unblock-File -LiteralPath .\\crap.ps1\n. .\\crap.ps1 -Install",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Client shell" }), {
    target: { value: "zsh" },
  });
  expect(
    screen
      .getByRole("link", { name: "Download Bash / Zsh installer" })
      .getAttribute("href"),
  ).toBe("/client-setup/crap.sh");
  expect(screen.getByText("source ./crap.sh install zsh")).toBeTruthy();
  expect(screen.getByText("https://proxy.example.ts.net:8443")).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Read the installation guide" })
      .getAttribute("href"),
  ).toContain("/client-setup/guide.md");
});
it("downloads a named single-use installer without asking for URLs or keys", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          filename: "crap.ps1",
          content: "fixture-script",
          expiresAt: Date.now() + 900000,
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const create = vi.fn(() => "blob:fixture");
  const originalCreate = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = create;
  URL.revokeObjectURL = vi.fn();
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    render(
      <ClientShellSetup
        endpoint={{
          origin: "https://proxy.example.ts.net:8443",
          openAI: null,
          label: "Tailscale",
          detail: "",
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set Up the crap Command" }),
    );
    const download = screen.getByRole("button", {
      name: "Download configured installer",
    });
    expect(download.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Computer name" }), {
      target: { value: "Work laptop" },
    });
    fireEvent.click(download);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      name: "Work laptop",
      shell: "powershell",
      mode: "proxy",
      cleanup: true,
    });
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  } finally {
    click.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
