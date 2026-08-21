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
# Sourcing scripts must define BASE (or BASE_URL) first, or set AURORA_SURFACE_AUTH_BASE explicitly.
#
# A shell function CANNOT shadow an absolute path. A script that calls "$CURL_BIN" where CURL_BIN is
# /usr/bin/curl silently sends no header while looking patched — which is exactly what happened to
# smoke_entry_routes.sh and is why the test asserts header DELIVERY against a real server rather
# than the presence of this source line.
#
# KNOWN LATENT ESCAPES, neither reachable from any current call site, both worth knowing before
# adding one:
#   * `curl -L` following a redirect to another host RESENDS custom -H headers (curl strips only
#     Authorization and Cookie). Node's fetch behaves the same way. A future `curl -L "$BASE/..."`
#     would turn a gateway open-redirect into key exfiltration. The only -L uses here fetch
#     raw.githubusercontent.com, which never matches the base.
#   * The match is per-argument but the header applies to the whole command line, so a single
#     invocation naming both the gateway and another host (`curl "$BASE/x" https://other/y`, or
#     `--next`) would send the key to both. No script does this today.

curl() {
  local key="${AURORA_SURFACE_INTERNAL_KEY:-}"
  local base="${AURORA_SURFACE_AUTH_BASE:-${BASE:-${BASE_URL:-}}}"
  # Strip every trailing slash. The previous `${base%%+(/)}` was DEAD CODE: extglob is off by
  # default in scripts, so `+(/)` was a literal pattern that never matched. One trailing slash
  # happened to work; two failed silently. BASE_URL comes from human-entered repo variables.
  while [ "${base%/}" != "$base" ]; do base="${base%/}"; done

  # BOTH guards are load-bearing. Without the `-n "$base"` check, an empty BASE makes the "$base"/*
  # arm degenerate to /* — which matches any argument starting with a slash, i.e. `-o /tmp/x`, and
  # then attaches the key to a request bound for anywhere. Tested.
  if [ -n "$key" ] && [ -n "$base" ]; then
    local arg
    for arg in "$@"; do
      # Base exactly, or base followed by a path/query/fragment separator. A bare prefix match also
      # accepts https://gw.example.evil.test/ for base https://gw.example — a lookalike host would
      # receive the shared secret. Tested.
      case "$arg" in
        "$base"|"$base"/*|"$base"\?*|"$base"#*)
          command curl -H "X-Internal-Key: ${key}" "$@"
          return $?
          ;;
      esac
    done
  fi
  command curl "$@"
  return $?
}
