import { CopyButton } from "./shared";
import { type ClientEndpoint, useClientEndpoint } from "@/lib/client-endpoint";
import { ClientShellSetup } from "./ClientShellSetup";

export function ClientEndpointDetails({
  endpoint,
}: {
  endpoint: ClientEndpoint;
}) {
  return (
    <div className="w-full min-w-0 space-y-4">
      <p className="text-xs text-primary">{endpoint.label}</p>
      {endpoint.openAI && endpoint.origin && (
        <>
          {[
            ["OpenAI base URL", endpoint.openAI],
            ["Claude base URL", endpoint.origin],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="eyebrow mb-2">{label}</p>
                <code className="break-all text-xs">{value}</code>
              </div>
              <CopyButton value={value} label={`Copy ${label}`} />
            </div>
          ))}
        </>
      )}
      <p className="quiet text-xs">{endpoint.detail}</p>
      <ClientShellSetup endpoint={endpoint} />
    </div>
  );
}
export function ClientEndpoints() {
  return <ClientEndpointDetails endpoint={useClientEndpoint()} />;
}
