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
