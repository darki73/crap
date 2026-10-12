#!/usr/bin/env bash
set -eu
source_file=$(cd "$(dirname "$0")" && pwd)/crap.sh
fixture=$(mktemp -d)
# All test paths are under a new temporary fixture; no real shell profile is used.
export CRAP_SHELL_HOME="$fixture/crap"
mkdir -p "$fixture/bin"
cat > "$fixture/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$PWD" "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_AUTH_TOKEN-}" "${ANTHROPIC_BASE_URL-}" > "$CRAP_TEST_OUTPUT"
printf '%s\n' "$@" >> "$CRAP_TEST_OUTPUT"
if [ "${1-}" = --settings ]; then cat "$2" > "$CRAP_TEST_OVERLAY"; fi
exit 23
EOF
chmod +x "$fixture/bin/claude"
export PATH="$fixture/bin:$PATH" CRAP_TEST_OUTPUT="$fixture/launch" CRAP_TEST_OVERLAY="$fixture/overlay"
export CLAUDE_CONFIG_DIR="$fixture/original-history" ANTHROPIC_AUTH_TOKEN=original-token ANTHROPIC_BASE_URL=https://original.example
# Install against an explicit fake home in a child shell, not the user's profile.
# The installer fixture below supplies a private ZDOTDIR for its supported Zsh target.
export ZDOTDIR="$fixture/profile"
mkdir -p "$ZDOTDIR"
printf '# original profile\n' > "$ZDOTDIR/.zshrc"
source "$source_file" install zsh
source "$source_file" install zsh
[ "$(grep -c '# CRAP shell integration' "$ZDOTDIR/.zshrc")" = 1 ]
set +e
claude --continue 'two words'
rc=$?
set -e
[ "$rc" = 23 ]
grep -Fxq 'two words' "$CRAP_TEST_OUTPUT"
grep -Fxq original-token "$CRAP_TEST_OUTPUT"
_crap_write "$CRAP_SHELL_HOME/clients/claude/endpoint" https://proxy.example
_crap_write "$CRAP_SHELL_HOME/clients/claude/key" fixture-client-key
crap use claude proxy
set +e
claude --continue 'two words'
rc=$?
set -e
[ "$rc" = 23 ]
grep -Fxq "$CLAUDE_CONFIG_DIR" "$CRAP_TEST_OUTPUT"
grep -Fxq "$PWD" "$CRAP_TEST_OUTPUT"
grep -Fxq fixture-client-key "$CRAP_TEST_OUTPUT"
grep -q '"ANTHROPIC_BASE_URL":"https://proxy.example"' "$CRAP_TEST_OVERLAY"
[ "$ANTHROPIC_AUTH_TOKEN" = original-token ]
[ "$ANTHROPIC_BASE_URL" = https://original.example ]
[ "$(find "$CRAP_SHELL_HOME/clients/claude" -name 'session.*' | wc -l | tr -d ' ')" = 0 ]
if claude --settings override.json; then exit 1; fi
crap use claude direct
# A fixture curl checks stdin ticket handling without contacting a live service.
curl() {
    local output arg received
    while [ "$#" -gt 0 ]; do
        arg=$1; shift
        case "$arg" in --output) output=$1; shift;; esac
    done
    received=$(cat)
    [ "$received" = fixture-ticket ] || return 1
    printf 'CRAP-ENROLLMENT-1\nhttps://configured.example\ncrap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' > "$output"
    printf 200
}
personalized="$fixture/download.sh"
cat "$source_file" > "$personalized"
printf '\n# CRAP enrollment payload\nif [ "$crap_install_result" = 0 ] && [ "${1-}" = install ]; then _crap_enroll https://panel.example fixture-ticket proxy yes "$crap_source_file"; fi\n' >> "$personalized"
source "$personalized" install zsh
[ ! -e "$personalized" ]
[ "$(_crap_mode)" = proxy ]
[ "$(cat "$(_crap_dir)/endpoint")" = https://configured.example ]
! grep -q fixture-ticket "$CRAP_SHELL_HOME/shell.sh"
[ "$(find "$CRAP_SHELL_HOME/clients/claude" -name 'enroll.*' | wc -l | tr -d ' ')" = 0 ]
curl() { printf 410; }
printf 'fixture' > "$personalized"
if _crap_enroll https://panel.example fixture-ticket proxy yes "$personalized"; then exit 1; fi
[ -e "$personalized" ]
fixture_probe_id=00000000-0000-4000-8000-000000000001
curl() {
    local output arg
    while [ "$#" -gt 0 ]; do arg=$1; shift; case "$arg" in --output) output=$1; shift;; esac; done
    [ "$(cat)" = fixture-ticket ] || return 1
    printf 'CRAP-ENROLLMENT-2\nhttps://fallback.example\ncrap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nhttps://lan.example\nhttps://lan.example\n%s\n' "$fixture_probe_id" > "$output"
    printf 200
}
_crap_enroll https://panel.example fixture-ticket proxy no "$personalized"
curl() {
    case "$*" in *Authorization*|*fixture-client-key*) return 1;; esac
    case "$*" in *'--max-time 2'*'--connect-timeout 2'*) ;; *) return 1;; esac
    printf 'CRAP-LAN-1:%s\n' "$fixture_probe_id"
}
[ "$(_crap_resolve_endpoint)" = https://lan.example ]
set +e
claude --continue
rc=$?
set -e
[ "$rc" = 23 ]
grep -q '"ANTHROPIC_BASE_URL":"https://lan.example"' "$CRAP_TEST_OVERLAY"
curl() { printf 'CRAP-LAN-1:wrong-workspace'; }
[ "$(_crap_resolve_endpoint)" = https://fallback.example ]
curl() { return 28; }
[ "$(_crap_resolve_endpoint)" = https://fallback.example ]
_crap_write "$(_crap_dir)/endpoint" https://lan.example
if _crap_resolve_endpoint; then exit 1; fi
unset -f curl
_crap_uninstall <<< REMOVE
! grep -q '# CRAP shell integration' "$ZDOTDIR/.zshrc"
grep -q '# original profile' "$ZDOTDIR/.zshrc"
[ ! -f "$CRAP_SHELL_HOME/clients/claude/key" ]
! typeset -f claude >/dev/null
claude() { printf custom; }
if source "$source_file" install zsh; then exit 1; fi
[ "$(claude)" = custom ]
printf '%s\n' 'POSIX shell install, idempotency, launch isolation, history, conflicts and uninstall passed.'
