# shellcheck shell=bash
#
# Attach X-Internal-Key to gateway requests, without editing every call site.
#
# PIVOTA-Agent #2038 added caller auth to the Aurora /v1 + /v2 surface. It runs in `observe` mode
# today; when it flips to `enforce`, any caller without the header gets a 401. These smoke scripts
# default BASE to the live gateway, so at the flip they would all start failing the release gate.
#
# They make dozens of curl calls between them and share no request helper, so this shadows `curl`
# with a shell function instead. Every `curl ...` in a sourcing script picks it up with no call-site
# change, and `command curl` reaches the real binary.
#
# THE HOST CHECK IS THE POINT, not a nicety. A blanket approach — ~/.curlrc, or appending the header
# unconditionally — would attach our shared secret to EVERY curl the job makes, including calls to
# third parties (image fixtures, GitHub, vendor APIs). The header is added only when an argument
# starts with the gateway base, so a request to anywhere else never carries it.
#
# Sourcing scripts must define BASE first, or set AURORA_SURFACE_AUTH_BASE explicitly.

curl() {
  local key="${AURORA_SURFACE_INTERNAL_KEY:-}"
  local base="${AURORA_SURFACE_AUTH_BASE:-${BASE:-}}"
  base="${base%%+(/)}"
  base="${base%/}"
  if [ -n "$key" ] && [ -n "$base" ]; then
    local arg
    for arg in "$@"; do
      # Match the base EXACTLY or followed by a path separator. A bare prefix match would also
      # accept https://gw.example.evil.test/... for base https://gw.example — a lookalike host
      # would receive the shared secret. Tested.
      case "$arg" in
        "$base"|"$base"/*|"$base"\?*)
          command curl -H "X-Internal-Key: ${key}" "$@"
          return $?
          ;;
      esac
    done
  fi
  command curl "$@"
}
