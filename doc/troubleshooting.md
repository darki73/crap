# Troubleshooting

[Documentation index](README.md)

First distinguish packaged ports (dashboard 13000, client 18317) from development
ports (Vite 5173, bridge 3001, client 8317). A Tailscale endpoint also needs the
client to be connected and allowlisted. Use the address shown by the active setup.

| Symptom                                     | Check / next step                                                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard connection refused or 404         | Confirm the correct port and running panel. For development, both Vite and its bridge must be running. Use the documented launcher.                                                             |
| 503 crap_not_ready                          | Inspect plugin enabled/loaded state, control and PostgreSQL health, maintenance state and pending/rejected delivery. Do not bypass the gateway.                                                 |
| 503 crap_configuration                      | Strict mode requires zero engine retries and disabled host cooldown. Review Proxy Configuration.                                                                                                |
| 429 crap_no_usable_account                  | Check every applicable five-hour, weekly and model window against the saved reserve, plus account/model eligibility. Wait for reset or connect another eligible owned account.                  |
| 500 affinity_no_headroom                    | This legacy selector error should not occur through the current strict path. Check the running plugin/version and deployment pairing; do not lower the reserve just to hide a stale deployment. |
| An almost-empty account is selected         | Fill-first behavior is intentional above reserve. A valid existing family wins. Below-reserve accounts must be excluded on the next request; inspect the observed windows and saved reserve.    |
| Account does not switch on overload         | Expected: temporary provider overload does not imply the account is unusable. Switching wastes cache and may not fix overload.                                                                  |
| OAuth callback localhost connection refused | Paste the complete callback URL into the waiting OAuth flow; start over if it expired. Keep code/state private.                                                                                 |
| Plan is unknown or still old                | Check collection status/time. Provider profile and token information can lag; do not infer the tier from a single model window.                                                                 |
| Quota refresh receives 429                  | Respect Retry-After/backoff. UI polling reads cached observations; repeated manual refreshes do not bypass provider admission.                                                                  |
| Unsupported protocol error                  | Strict CRAP supports Claude Messages and token counting. Dashboard provider configuration is broader than supported inference.                                                                  |
| PowerShell says script is unsigned          | Review it, then use Unblock-File for RemoteSigned. AllSigned needs an approved signed script; do not weaken policy.                                                                             |
| Existing claude/crap alias conflict         | Resolve the custom command deliberately; the installer refuses to overwrite it. See the shell guide.                                                                                            |
| Telegram pairing is delayed                 | Use the newest pairing link and send Start in a private chat. Check expiry, Telegram backoff and competing bot polling/webhooks.                                                                |
| Telegram link does not open remotely        | Verify Tailscale dashboard access, allowlisted login and connectivity on the receiving device. Localhost points to that device, not the server.                                                 |
| Ledger total looks larger than the message  | Inspect cache reads/writes, resumed context and multiple client calls. Totals are not automatically fresh paid prefill.                                                                         |
| Missing token/cache duration                | Preserve unknown values. Inspect delivery coverage/spool; a callback never received cannot be reconstructed.                                                                                    |
| Bootstrap or schema mismatch                | Preserve all state, use matching checkout/images and follow recovery. Never delete secret volumes or migration rows to force startup.                                                           |

## Packaged diagnostics

Run from the matching repository checkout/project:

```sh
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml exec -T panel node deploy/health.mjs
docker compose -f deploy/compose.yaml logs --tail=100 gateway control
```

Inspect output privately before sharing it. Include sanitized error code, component
versions, deployment type, time and reproduction steps in a bug report. Exclude
OAuth codes, keys, bot tokens, full emails, prompts and database dumps.

For interrupted writes or rejected delivery, preserve the files and take a backup
before repair. Do not delete queue records merely to make readiness green.
[Operations](../deploy/OPERATIONS.md) covers draining, encrypted recovery and rollback.
