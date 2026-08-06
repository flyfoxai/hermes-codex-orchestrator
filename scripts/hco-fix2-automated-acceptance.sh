#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/docs/superpowers/test-artifacts/2026-07-22-hco-fix2-automated"
send=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --send) send=true; shift ;;
    --output) out=${2:?--output requires a path}; shift 2 ;;
    *) printf 'usage: %s [--output PATH] [--send]\n' "$0" >&2; exit 2 ;;
  esac
done
mkdir -p "$out"
status=0
run() {
  name=$1
  shift
  set +e
  "$@" >"$out/$name.log" 2>&1
  code=$?
  set -e
  printf '%s\t%s\n' "$name" "$code" >>"$out/commands.tsv"
  if [ "$code" -ne 0 ]; then status=1; fi
}
: >"$out/commands.tsv"
run python-contract /Users/hula/Projects/hermesAgent/venv/bin/python3 -m pytest -q "$repo/test/hermes_plugin_contract_test.py"
run node-tests node --test "$repo"/test/*.test.js
fake_rg=$(mktemp -d)
trap 'rm -rf "$fake_rg"' EXIT
cat >"$fake_rg/rg" <<'EOF'
#!/usr/bin/env bash
printf 'UNEXPECTED_RG_INVOCATION\n' >>"${HCO_FAKE_RG_LOG:?}"
exit 99
EOF
chmod 700 "$fake_rg/rg"
run installer-portable env -u HCO_CONFIG_PATH HCO_FAKE_RG_LOG="$out/fake-rg.log" PATH="$fake_rg:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin" bash "$repo/test/install-hermes-codex-bridge.test.sh"
run pycompile /Users/hula/Projects/hermesAgent/venv/bin/python3 -m py_compile "$repo"/plugin/hermes-codex-bridge/*.py
run syntax node --check "$repo/hco/service.js"
run diff-check git -C "$repo" diff --check
run tracked-bytecode bash -c "test -z \"\$(git -C \"$repo\" ls-files | grep -E '(^|/)(__pycache__/|.*\\.(pyc|pyo|pyd)$)' || true)\""
if test -s "$out/fake-rg.log"; then status=1; fi
preflight_ready=false
if [ -n "${HCO_CONFIG_PATH:-}" ]; then
  smoke_args=(
    --hco-config "$HCO_CONFIG_PATH"
    --output-json "$out/post-deploy-smoke.json"
    --output-markdown "$out/post-deploy-smoke.md"
  )
  if [ -n "${HCO_SMOKE_INSTALL_ROOT:-}" ]; then smoke_args+=(--install-root "$HCO_SMOKE_INSTALL_ROOT"); fi
  if [ -n "${HCO_SMOKE_STABLE_LINK:-}" ]; then smoke_args+=(--stable-link "$HCO_SMOKE_STABLE_LINK"); fi
  if [ -n "${HCO_SMOKE_ATTESTATION_FILE:-}" ]; then smoke_args+=(--attestation-file "$HCO_SMOKE_ATTESTATION_FILE"); fi
  if [ -n "${HCO_SMOKE_UNMAPPED_STREAM_ID:-}" ]; then smoke_args+=(--unmapped-stream-id "$HCO_SMOKE_UNMAPPED_STREAM_ID"); fi
  if [ -n "${HCO_SMOKE_PROJECT_STREAM_ID:-}" ]; then smoke_args+=(--project-stream-id "$HCO_SMOKE_PROJECT_STREAM_ID"); fi
  if [ -n "${HCO_SMOKE_HERMES_STREAM_ID:-}" ]; then smoke_args+=(--hermes-stream-id "$HCO_SMOKE_HERMES_STREAM_ID"); fi
  set +e
  /Users/hula/Projects/hermesAgent/venv/bin/python3 "$repo/scripts/hco-post-deploy-smoke.py" "${smoke_args[@]}" >"$out/post-deploy-smoke.log" 2>&1
  smoke_code=$?
  set -e
  printf '%s\t%s\n' post-deploy-smoke "$smoke_code" >>"$out/commands.tsv"
  if [ "$smoke_code" -eq 0 ]; then
    preflight_ready=true
  else
    status=1
  fi
else
  printf '%s\t%s\n' post-deploy-smoke SKIPPED_NO_RUNTIME_CONFIG >>"$out/commands.tsv"
fi
if $send; then
  if $preflight_ready; then
    set +e
    /Users/hula/Projects/hermesAgent/venv/bin/python3 "$repo/scripts/hco-fix2-api-acceptance.py" --send --output "$out/zulip-api.json" >"$out/zulip-api.log" 2>&1
    api_code=$?
    set -e
    printf '%s\t%s\n' zulip-api "$api_code" >>"$out/commands.tsv"
    if [ "$api_code" -ne 0 ]; then status=1; fi
  else
    printf '%s\t%s\n' zulip-api BLOCKED_PREFLIGHT_REQUIRED >>"$out/commands.tsv"
    status=1
  fi
else
  printf '%s\t%s\n' zulip-api SKIPPED_NO_SEND >>"$out/commands.tsv"
fi
printf 'status=%s\n' "$([ "$status" -eq 0 ] && echo PASS || echo FAIL)"
exit "$status"
