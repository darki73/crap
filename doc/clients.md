# Set up the crap command

[Documentation index](README.md)

The shell integration adds an interactive `crap` menu and a `claude` function
around the existing official Claude Code executable. It installs scripts, not a
separate application or background service. Claude must already be installed.
Supported shells are PowerShell on Windows and Bash/Zsh on Linux/macOS. Other
clients may be detected, but only the Claude adapter is implemented.

## Automatic configuration

1. Open **Client API Keys → Set Up the crap Command** (also available in Setup).
2. Choose automatic configuration, name the computer and select its initial mode.
3. Download and review the generated script on that computer.
4. Run the appropriate installation command below in the target shell.
5. Open `crap`, check status and run `crap doctor` before an inference test.

The installer contains a 15-minute, single-use enrollment ticket. Redemption issues
a dedicated client API key and the active endpoint; provider tokens and management
secrets are not shipped to clients. Treat the unredeemed download as sensitive.
Successful setup can remove it, but cannot delete browser backups or other copies.

If setup is interrupted, inspect **Connected computers** and revoke/remove the
record before generating a replacement. “Key issued” is a server acknowledgement,
not proof the local shell installation finished. Avoid simultaneous key-list edits
through another management tool.

## Install commands

Run from the download directory after reviewing the script:

```powershell
Unblock-File -LiteralPath .\crap.ps1
. .\crap.ps1 -Install
```

Keep the leading dot and space. Unblocking removes that file's internet-zone mark;
it does not weaken execution policy. It helps with RemoteSigned, not an enforced
AllSigned policy. Managed machines need the administrator's approved signing flow.

```bash
source ./crap.sh install bash
# For Zsh instead:
source ./crap.sh install zsh
```

The installer backs up an existing profile and refuses conflicting custom aliases
rather than overwriting them. Bash login profiles must load .bashrc; Zsh uses
.zshrc. PowerShell uses the current-user/current-host profile.

## Everyday commands

```text
crap                         open the menu
crap status                  inspect mode and endpoint
crap use claude proxy        use CRAP for future launches
crap use claude direct       use the original launch behavior
crap configure claude        manually update endpoint and client key
crap doctor                  check authentication/connectivity without inference
crap uninstall               remove the loader and saved proxy credentials
```

Then use `claude` normally, including resume/continue. Switching affects new
launches, not a running process. The same configuration directory and chat history
are preserved; no separate “CRAP Claude” history is created. Direct mode restores
the original environment, including any routing you already configured yourself.
There is no automatic fallback to direct mode if CRAP fails.

The Claude origin has no trailing /v1. A localhost origin works only on the proxy
machine; remote clients need the reachable Tailscale endpoint and an allowed login.

## Storage and limits

Windows stores state under %LOCALAPPDATA%/CRAP with a user-only ACL and a
DPAPI-protected key. Bash/Zsh use ~/.local/share/crap with private permissions.
Proxy launches use a temporary settings overlay, removed on normal exit. Forced
termination can leave it in the protected state directory. Profile loaders contain
no keys. Managed policy is not overridden; conflicting flags/policies can prevent
proxy mode. See the [full shell contract](../control-panel/client-shell/guide.md)
for uninstall, manual setup, reserved flags and adapter development.

## Prefer a LAN connection

In **Setup & Integrations → LAN Connection** (also in **Client API Keys**), enable
LAN preference and save your HTTPS dashboard and API origins. They may be the same
origin when your ingress routes `/v1` and `/v1/…` to the CRAP gateway and other paths
to the panel. Do not add `/v1` to the saved origin. Configure DNS, a valid certificate,
the panel's allowed origins, and ingress access controls separately. A LAN deployment
can trust an ingress IP allowlist; every device admitted to the dashboard is then an
administrator. Inference still requires a client API key. Never expose the proxy's
management listener through this route.

Download and run a new personalized installer after changing these settings. It
saves the LAN addresses and, if online and enabled during enrollment, the Tailscale
inference address as a fallback. Old installations keep their previous settings.
Revoke an old device key once its replacement is installed and verified.

At each proxy-mode launch, the shell makes a credential-free HTTPS probe to the LAN
dashboard with a short timeout. It checks a public workspace marker, validates TLS
normally, and does not follow redirects. If the probe matches, it chooses LAN;
otherwise it chooses the saved fallback. Without a fallback it reports that LAN is
unreachable. This is a reachability check, not a guarantee of inference health.
`crap doctor` uses the same selection before checking the authenticated model list.

The selected route stays fixed for the whole Claude process. Moving off the LAN
requires relaunching Claude; CRAP does not replay a request or switch a stream between
transports. Direct mode bypasses these checks and keeps your usual Claude connection
and history. Disabling LAN preference affects newly generated installers; rerun one
on existing devices to remove their saved LAN preference.
