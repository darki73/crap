# Tailscale and Telegram

[Documentation index](README.md)

Both integrations live in **Setup & Integrations** and start disconnected. They
are optional. The packaged stack includes the Tailscale helper; development may
need its build step. Keep one active integration owner for a workspace.

## Private access with Tailscale

1. Open the Tailscale setup flow and choose a node hostname.
2. Enter the exact Tailscale login emails allowed to access this workspace.
   Every allowed dashboard identity is an administrator; there are no viewer roles.
3. Choose dashboard access, inference access, or both. Inference also requires a
   client API key. Tailscale identity does not replace client-key authentication.
4. Follow the interactive sign-in, or supply a **device auth key** when offered.
   A tailnet API token or OAuth client secret is not the accepted key type.
5. Follow any HTTPS setup instruction, wait for Online, and use the displayed URL.
6. On another computer, connect Tailscale with an allowed identity and configure
   its client using the displayed inference origin.

This is private tailnet access, not a public Funnel/ingress publishing feature.
The packaged remote inference path still uses CRAP's checked gateway. Do not expose
the raw proxy to work around a connection problem.

Preserve the panel's local Tailscale state with a full workspace backup. A logical
database transfer does not carry the old node identity files. Restored copies must
not run alongside the original identity. See [migration](storage.md).

## Telegram pairing

1. Create a bot with Telegram's BotFather and enter its token in the setup flow.
2. Start pairing. Open the generated bot link in Telegram and press Start/send the
   generated start message in your private chat.
3. Return to CRAP and wait for the paired status before enabling notifications.
4. Select account alerts, quota alerts and/or a daily digest. Review the quota
   threshold and digest hour; the digest scheduler uses UTC.
5. Use the explicit test action when you want a test message sent.

Pairing actively checks about every two seconds while pending, subject to Telegram
backoff. Expired pairing codes need a new pairing flow. A bot used by another
polling process or an existing webhook can conflict with this flow; use a dedicated
bot and inspect the displayed error instead of repeatedly reconnecting.

Bot credentials and chat configuration are stored in CRAP's encrypted integration
settings. They require the matching workspace identity key during recovery.
Notifications mask account emails and identify quota windows/reset times. A low
quota episode is deduplicated; small drift in a reported reset must not generate a
new notification every five minutes. Recovery or a new window can allow a new alert.

## Links that work outside the server

Telegram dashboard links follow the active access configuration, including the
Tailscale dashboard URL. The receiving device must be on the tailnet and allowed
to open that dashboard. If Tailscale dashboard access is unavailable, a local URL
cannot make the server reachable from a phone. Configure and verify remote access
before relying on notification buttons; notifications themselves do not grant it.

After a destination import, review addresses and explicitly re-enable integrations.
Tailscale/Telegram are paused on logical import to avoid duplicate nodes/workers.
Never put bot tokens, auth keys or enrollment downloads in issue attachments.
