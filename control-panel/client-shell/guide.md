# CRAP client shell setup

Install the maintained CRAP shell scripts. Do not invent a new wrapper or modify
Claude's binary, login, configuration directory, project settings, or chat history.
These scripts add an interactive `crap` menu and a `claude` function which launches
the existing official client. Direct is the initial mode. Switching only affects
new launches; continuing a conversation sends its context to the selected provider.

## Supported environments

- Windows PowerShell: download `crap.ps1` beside this guide.
- Linux/macOS Bash or Zsh: download `crap.sh` beside this guide.
- Fish, CMD, IDE extensions, managed Claude installations, and other CLI client
  adapters are not supported yet. Codex/Gemini are detected but never reconfigured.
- Use an official Claude Code version supporting `--settings` with a JSON file.
  CRAP supplies a per-launch settings overlay in proxy mode. User/project settings
  remain in place; managed policy is not overridden. Locally detected managed
  settings block proxy launches. Server-delivered/OS-managed policy may require
  administrator review; the wrapper does not promise to override it.

## Install on the client computer

The dashboard defaults to **Configure this computer automatically**. Name the
computer, choose its starting connection and download the configured installer.
It contains a single-use setup ticket (15-minute lifetime), not provider tokens
or a management key. Keep the download private until redeemed. Tailscale must be
connected with an allowed identity when using a private address. Local setup
works only on the proxy computer. No URL or client-key entry is needed.

Installation exchanges the ticket for a dedicated client API key. Windows stores
it using DPAPI; Bash/Zsh use a private file. The ticket is stripped from the
persistent shell script. Successful setup optionally deletes the downloaded file
and opens the connection menu. A failed setup keeps the download. Browser backups
and other copies are not deleted, but an expired or consumed ticket cannot be reused.

**Client API Keys → Connected computers** shows setup status and offers removal,
which cancels unused tickets or revokes issued keys. “Key issued” confirms the
server issued credentials; it does not prove the local installation completed.
After an interrupted exchange, remove the device before generating a new installer.
Uncheck automatic configuration for the generic/manual installation below.

If the control-room process stopped during a key update, the durable write lock
deliberately blocks further enrollment. Stop the previous process and any other
control-room instances, then use the recovery checkbox when removing that device.
This reconciles and revokes a possibly issued key. Do not recover a running setup.
Enrollment serializes its own key updates; avoid concurrent changes to the same
key list through other management tools (the upstream API replaces that list).

Download and review the script before sourcing it. The download contains no key.
Run from the directory containing the download, in the shell you want to configure:

```powershell
Unblock-File -LiteralPath .\crap.ps1
. .\crap.ps1 -Install
```

After reviewing the downloaded script, `Unblock-File` removes its Windows internet
zone marker so `RemoteSigned` can run it. This changes only the selected file, not
the execution policy. Keep the leading dot and space on the install line: they
load the functions into your current PowerShell session. If your organization
requires `AllSigned` scripts, unblocking is not sufficient; use an approved signed
installer and follow your administrator's policy.

```bash
source ./crap.sh install bash
# Or, from Zsh:
source ./crap.sh install zsh
```

No administrator access, execution-policy change, package manager, new executable,
or background process is required. If policy prevents running a script, follow
your organization's signing/policy process rather than disabling the policy.
macOS Bash users must already load `.bashrc` from their login profile, or source it
manually; Zsh uses `.zshrc`. PowerShell uses the current user's current-host profile.
The installer backs up an existing profile before adding a single loader line.
It refuses conflicting `claude`/`crap` aliases or functions. Resolve the conflict
with the user instead of deleting their custom command. Re-running the installer
for the same profile updates scripts without adding duplicate loader lines.

## Configure

Run `crap`, choose **Configure Claude connection**, and enter the Claude API origin
shown in the dashboard (without `/v1`). Paste a **client API key**, not a provider
OAuth token or management secret, at the hidden prompt. Do not put the key in
commands, URLs, prompts to an agent, or shell history. Select **Claude: use proxy**.
Use `claude` normally, including `--continue`, `--resume`, and project arguments.
The existing `CLAUDE_CONFIG_DIR`, if any, is preserved. There is no separate CRAP
chat history. Direct mode delegates to the saved executable with the original
environment/settings; pre-existing custom routing is therefore preserved too.

```text
crap                         interactive client menu
crap status                  mode and configured endpoint (never the key)
crap configure claude        enter/update the proxy address and key
crap use claude proxy        select proxy for future launches
crap use claude direct       restore original launch behavior
crap doctor                  authenticated /v1/models check; no inference request
crap uninstall               remove loader and saved proxy credentials
```

For a Tailscale origin the client machine must be on the tailnet, with an allowed
login. `crap doctor` checks connectivity/authentication; it does not prove every
listed model supports Claude's protocol. Run an inference test only when the user
requests one. There is no automatic fallback to direct mode if the proxy fails.

## Files and credentials

Windows stores scripts/configuration under `%LOCALAPPDATA%\CRAP` with a user-only
directory ACL and a DPAPI-encrypted key. Bash/Zsh use `~/.local/share/crap` with
directory mode 700 and credential files mode 600. Each client gets its own state
under `clients/<client>`. A per-launch settings file is removed on normal exit;
forced process termination may leave one in that same protected directory.
Neither profile loader contains credentials. Both modes preserve Claude's existing
history; CRAP does not copy or delete it. Proxy mode reserves `--settings` and
`--setting-sources` to keep connection settings consistent.

Uninstall removes the exact installed loader line and saved proxy key/address.
Scripts and profile backups remain for review; other open shells need restarting.
Do not delete leftover session files while a proxy Claude session is running.

## For agents

Explain the chosen shell/profile and preserve pre-existing shell customizations.
Use these maintained scripts; never fetch and execute arbitrary third-party code.
The user enters their key locally at the hidden prompt. Never request provider
credentials. Do not enable proxy mode, send a paid query, or replace a conflicting
custom alias without the user's instruction. The guide can be private: agents
reading it must have access to the same Tailscale dashboard as the user.

## Adding another client adapter

Keep endpoint/authentication, direct/proxy state, launch argument handling,
conflict detection, and cleanup under that client's namespace. Do not assume
Claude variables or flags work for Codex/Gemini. Add launch-contract tests that
verify original arguments, exit status, working directory, history location,
credential isolation, direct restoration, installation and uninstall. Expose the
adapter as supported only after those contracts have been implemented and tested.
