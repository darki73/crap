import { Paginated } from "@/components/Paginated";
import { useEffect, useState } from "react";
import { api, write, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { SectionTitle } from "./shared";

type Device = { id: string; name: string; status: string; suffix?: string };
export function ClientDevices({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recover, setRecover] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const items = await api<Device[]>("/client-enrollment");
        if (active) setDevices(items);
      } catch {
        /* Generic/manual client setup remains available without enrollment storage. */
      }
      if (active) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await write("/client-enrollment", "DELETE", { id, recover });
      setDevices((items) => items.filter((d) => d.id !== id));
      setConfirm(null);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  if (!devices.length) return null;
  return (
    <section className="surface mb-6">
      <SectionTitle
        title="Connected computers"
        detail="Each installer creates its own revocable client key."
      />
      <Paginated items={devices} label="computers">
        {(pageRows) => (
          <div className="divide-y">
            {pageRows.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 p-5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{d.name}</p>
                  <p className="quiet text-xs">
                    {d.status === "installed"
                      ? "Key issued"
                      : d.status === "pending"
                        ? "Waiting for installation"
                        : d.status === "uncertain"
                          ? "Setup incomplete · check or revoke key"
                          : d.status}
                    {d.suffix ? ` · key ending ${d.suffix}` : ""}
                  </p>
                </div>
                {confirm === d.id ? (
                  <>
                    <span className="text-xs">
                      Revoke access and remove this computer?
                    </span>
                    {["issuing", "revoking"].includes(d.status) && (
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={recover}
                          onChange={(e) => setRecover(e.target.checked)}
                        />
                        Recover interrupted setup: I have stopped the previous
                        setup process and all other control-room instances.
                      </label>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void remove(d.id)}
                    >
                      Confirm removal
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRecover(false);
                      setConfirm(d.id);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Paginated>
      {error && (
        <p role="alert" className="p-5 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
