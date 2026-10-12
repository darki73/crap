import { useState } from "react";
import { Network } from "lucide-react";
import { api, write, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

type Settings = {
  enabled: boolean;
  dashboardOrigin: string;
  apiOrigin: string;
};
export function LanAccessSetup() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    enabled: false,
    dashboardOrigin: "",
    apiOrigin: "",
  });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function show() {
    setOpen(true);
    setBusy(true);
    setLoaded(false);
    setError("");
    setNotice("");
    try {
      const data = await api<{ lanAccess?: Settings }>("/integrations");
      setSettings(
        data.lanAccess || {
          enabled: false,
          dashboardOrigin: "",
          apiOrigin: "",
        },
      );
      setLoaded(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await write("/integrations/lan/configure", "POST", settings);
      setNotice(
        "Saved. Download a new personalized shell installer on each computer to apply these addresses. Existing Claude processes keep their current connection.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={() => void show()}>
        <Network size={14} /> LAN Connection
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Close to home. Connected anywhere.</DialogTitle>
            <DialogDescription>
              Prefer your local network when it is reachable, with Tailscale as
              an optional fallback.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 text-sm">
            <div className="rounded-lg border bg-primary/5 p-4">
              <p className="font-medium">One choice before each launch</p>
              <p className="quiet mt-2 text-xs leading-relaxed">
                The crap shell checks your LAN dashboard without sending a key.
                If it reaches this workspace, Claude uses the LAN API. Otherwise
                it uses the Tailscale address saved by the installer. The route
                stays fixed until you close Claude.
              </p>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-primary"
                checked={settings.enabled}
                disabled={!loaded || busy}
                onChange={(e) =>
                  setSettings({ ...settings, enabled: e.target.checked })
                }
              />{" "}
              Prefer LAN access
            </label>
            <fieldset
              disabled={!loaded || busy || !settings.enabled}
              className="space-y-4 disabled:opacity-50"
            >
              <label className="block space-y-2">
                <span>LAN dashboard origin</span>
                <Input
                  type="url"
                  placeholder="https://panel.example.com"
                  value={settings.dashboardOrigin}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      dashboardOrigin: e.target.value,
                    })
                  }
                />
              </label>
              <label className="block space-y-2">
                <span>LAN API origin</span>
                <Input
                  type="url"
                  placeholder="https://panel.example.com"
                  value={settings.apiOrigin}
                  onChange={(e) =>
                    setSettings({ ...settings, apiOrigin: e.target.value })
                  }
                />
                <span className="quiet block text-xs">
                  Use the origin only, without /v1. Both addresses can be the
                  same.
                </span>
              </label>
            </fieldset>
            <p className="quiet text-xs leading-relaxed">
              First configure HTTPS, DNS and a private ingress to the panel and
              CRAP gateway. Restrict dashboard access at your ingress to trusted
              devices. API requests still need a client key. Saving these
              addresses does not create an ingress or change its access policy.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-primary">
                {notice}
              </p>
            )}
            <div className="flex justify-end">
              <Button disabled={!loaded || busy} onClick={() => void save()}>
                {busy ? "Please wait…" : "Save LAN Connection"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
