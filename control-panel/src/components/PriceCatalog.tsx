import { Paginated } from "@/components/Paginated";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorNotice } from "@/components/shared";
import { api, errorMessage } from "@/lib/api";

export type PriceVersion = {
  id: number;
  provider: string;
  model: string;
  service_tier: string;
  effective_from: string;
  input_rate: string;
  cache_read_rate: string;
  cache_write_rate: string | null;
  cache_write_5m_rate?: string | null;
  cache_write_1h_rate?: string | null;
  output_rate: string;
  reasoning_rate: string;
  note: string;
};
const rateFields = [
  ["inputRate", "Uncached input"],
  ["cacheReadRate", "Cache reads"],
  ["outputRate", "Output"],
  ["reasoningRate", "Reasoning"],
] as const;
export function PriceCatalog({
  prices,
  onSaved,
}: {
  prices: PriceVersion[];
  onSaved: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const visible = prices.filter((p) =>
    `${p.provider} ${p.model} ${p.service_tier}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    provider: "claude",
    model: "",
    serviceTier: "",
    effectiveDate: new Date().toISOString().slice(0, 10),
    inputRate: "",
    cacheReadRate: "",
    cacheWriteRate: "",
    cacheWrite5mRate: "",
    cacheWrite1hRate: "",
    outputRate: "",
    reasoningRate: "",
    note: "",
  });
  const durationRates = draft.provider.trim().toLowerCase() === "claude";
  const fields = [
    ...rateFields,
    ...(durationRates
      ? ([
          ["cacheWrite5mRate", "5-minute cache writes"],
          ["cacheWrite1hRate", "1-hour cache writes"],
        ] as const)
      : ([["cacheWriteRate", "Cache writes"]] as const)),
  ];
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const {
      effectiveDate,
      cacheWriteRate,
      cacheWrite5mRate,
      cacheWrite1hRate,
      ...base
    } = draft;
    const price = {
      ...base,
      provider: base.provider.trim().toLowerCase(),
      ...(durationRates
        ? { cacheWrite5mRate, cacheWrite1hRate }
        : { cacheWriteRate }),
    };
    try {
      await api("/affinity/prices", {
        method: "POST",
        body: JSON.stringify({
          ...price,
          effectiveFrom: `${effectiveDate}T00:00:00.000Z`,
        }),
      });
      await onSaved();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface mb-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">Price Catalog</h2>
          <p className="quiet mt-1 text-xs">
            Your verified USD rates per million tokens. Each saved version is
            immutable.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Close editor" : "Add rate version"}
        </Button>
      </div>
      {error && (
        <div className="mt-4">
          <ErrorNotice message={error} />
        </div>
      )}
      {open && (
        <form
          onSubmit={(event) => void save(event)}
          className="mt-5 grid gap-4 md:grid-cols-3"
        >
          <label className="text-xs">
            Provider
            <Input
              required
              className="mt-2"
              value={draft.provider}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Exact reported model
            <Input
              required
              className="mt-2"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Service tier (blank if absent)
            <Input
              className="mt-2"
              value={draft.serviceTier}
              onChange={(e) =>
                setDraft({ ...draft, serviceTier: e.target.value })
              }
            />
          </label>
          <label className="text-xs">
            Effective date (UTC)
            <Input
              required
              type="date"
              className="mt-2"
              value={draft.effectiveDate}
              onChange={(e) =>
                setDraft({ ...draft, effectiveDate: e.target.value })
              }
            />
          </label>
          {fields.map(([key, label]) => (
            <label key={key} className="text-xs">
              {label} / million
              <Input
                required
                inputMode="decimal"
                pattern="(0|[1-9][0-9]*)(\.[0-9]{1,8})?"
                className="mt-2"
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="text-xs md:col-span-3">
            Source and assumptions
            <Input
              required
              placeholder="Official rate source and applicable pricing conditions"
              className="mt-2"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <p className="quiet text-xs md:col-span-3">
            Rates match the exact provider, model and tier. Existing estimates
            are preserved; eligible unpriced requests are backfilled. OAuth
            estimates are API-equivalent values, not subscription charges.
            Claude writes use observed 5-minute and 1-hour counters. If the
            split is missing, the request stays unpriced; these rates do not
            change cache duration.
          </p>
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : "Save rate version"}
          </Button>
        </form>
      )}
      {!prices.length && !open && (
        <p className="quiet mt-4 text-sm">
          No rates configured. Unknown prices stay unpriced.
        </p>
      )}
      {!!prices.length && (
        <>
          <Input
            aria-label="Search price catalog"
            placeholder="Search model, provider or tier…"
            className="mt-4 max-w-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!visible.length && (
            <p className="quiet mt-4 text-sm">No matching rates.</p>
          )}
          <Paginated key={search} items={visible} label="rates" loadedOnly>
            {(pageRows) => (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="quiet">
                    <tr>
                      {[
                        "Model / tier",
                        "Effective",
                        "Input",
                        "Cache read",
                        "5m write",
                        "1h write",
                        "Aggregate write",
                        "Output",
                        "Reasoning",
                      ].map((h) => (
                        <th
                          key={h}
                          className="whitespace-nowrap py-3 pr-4 font-normal"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((p) => (
                      <tr key={p.id} className="border-t">
                        <td className="py-3 pr-4">
                          {p.provider} / {p.model}
                          <p className="quiet mt-1 min-w-52 max-w-sm leading-relaxed">
                            {p.service_tier || "Unspecified tier"} ·{" "}
                            {p.note
                              .split(/(https?:\/\/[^\s]+)/g)
                              .map((part, index) =>
                                /^https?:\/\//.test(part) ? (
                                  <a
                                    key={index}
                                    href={part}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline underline-offset-2 hover:text-foreground"
                                    title={part}
                                  >
                                    Source
                                  </a>
                                ) : (
                                  part
                                ),
                              )}
                            {p.provider === "claude" &&
                              p.cache_write_rate != null &&
                              " · Legacy duration assumption"}
                          </p>
                        </td>
                        <td className="whitespace-nowrap pr-4">
                          {p.effective_from.slice(0, 10)}
                        </td>
                        {[
                          p.input_rate,
                          p.cache_read_rate,
                          p.cache_write_5m_rate,
                          p.cache_write_1h_rate,
                          p.cache_write_rate,
                          p.output_rate,
                          p.reasoning_rate,
                        ].map((rate, i) => (
                          <td key={i} className="pr-4 font-mono">
                            {rate == null
                              ? "—"
                              : `$${rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate}`}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Paginated>
        </>
      )}
    </section>
  );
}
