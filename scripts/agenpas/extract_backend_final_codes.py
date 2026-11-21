#!/usr/bin/env python3
"""Regenerate tests/fixtures/agenpas_backend_final_codes.backend.json from a pivota-backend checkout.

The AgenPas page words every final purchase state from the backend's codes (src/agenpas/view.js). The parity test
tests/agenpas_terminal_codes_parity.node.test.cjs checks that every code the backend WRITES into a final state is on an
explicit gateway list. This script is how that list is kept honest on every re-pin: it reads the backend source at one
commit (read only, `git show`; nothing is run, nothing is fetched) and prints the codes, per rail and state.

    python3 -I scripts/agenpas/extract_backend_final_codes.py --repo ~/dev/pivota-backend --sha <sha> \
        > tests/fixtures/agenpas_backend_final_codes.backend.json

What it reads (static values only):
  A2A  services/payment_orchestration/a2a_rail_worker.py: every `transition_as_holder(..., to_state=<final>,
       last_error_code= / refusal_reason=)`, `_token_failed(s, state, code)`, `_checkout_failed(s, code)`,
       `_cancel_checkout(s, code)`; module constants (also from a2a_shipping_address.py); `f"x:{...}"` codes keep their
       head as `x:<arg>`; `_code("x", result)` is `x:<kind>:<status>`; `ended = {...}` tuples.
       db/a2a_rail_ledger.py: the codes the expiry sweep writes (`THEN '<code>'` / `ELSE '<code>'`).
  Reap services/reap_agentic_purchase.py: every `_move(..., "<final>", last_error_code= / refusal_reason=)`, the
       `_QUOTE_REFUSAL_KINDS` values, the `PurchaseRefused("<reason>")` literals of `_row_scope` and the pilot-scope
       functions behind it (written as `refusal_reason=exc.reason`), the static returns of the verdict helpers, and,
       for a value it cannot resolve directly, the literals that value is built from in its function (a default like
       `str(x or "enrollment_read_failed")`, `_error_code("ENROLLMENT_NOT_ACTIVE")`) or the returns of a helper it calls; db/reap_agentic_ledger.py: the
       `last_error_code = '<code>'` of its terminal sweeps; services/reap_checkout_recovery.py: `manual_provider_<status>`;
       routes/agent_commerce_reap.py: `refusal_reason=` literals; services/reap_agentic_client.py: `reason="..."`
       resolution reasons (written verbatim as `refusal_reason`).
What it cannot read (listed under "dynamic" in the output): codes built at run time from a partner's answer
(`_error_code(<partner code>)`), and helper arguments it cannot resolve to a literal.

HOOK: if the backend ships its own contract file of final codes (`--contract <path in the backend repo>`), its
per-state lists are merged in, so the test checks the union.
"""
import argparse
import ast
import json
import re
import subprocess
import sys

FINAL = ("failed", "refused", "expired")
A2A_WORKER = "services/payment_orchestration/a2a_rail_worker.py"
A2A_SHIPPING = "services/payment_orchestration/a2a_shipping_address.py"
A2A_LEDGER = "db/a2a_rail_ledger.py"
REAP_SERVICE = "services/reap_agentic_purchase.py"
REAP_LEDGER = "db/reap_agentic_ledger.py"
REAP_RECOVERY = "services/reap_checkout_recovery.py"
REAP_ROUTES = "routes/agent_commerce_reap.py"
REAP_CLIENT = "services/reap_agentic_client.py"
# Verdict helpers whose static string returns are refusal reasons on a refused row (services/reap_agentic_purchase.py).
REAP_VERDICT_HELPERS = ("_preflight_refusal_reason", "_cart_link_verdict", "_single_variant_verdict", "_price_verdict")
# The functions behind `_row_scope` (services/reap_agentic_purchase.py), whose PurchaseRefused reasons a refused row carries.
REAP_SCOPE_FUNCTIONS = ("_row_scope", "enforce_pilot_scope", "_pilot_scope")
CODE_RE = re.compile(r"^[a-z][a-z0-9_]*(?:<arg>)?(?::[a-z0-9_<>]+)*$")


def show(repo, sha, path):
    return subprocess.run(["git", "-C", repo, "show", f"{sha}:{path}"], check=True, capture_output=True, text=True).stdout


def constants(tree):
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                out[node.targets[0].id] = node.value.value
            if isinstance(node.value, ast.Attribute) and isinstance(node.value.value, ast.Name):
                out[node.targets[0].id] = ("attr", node.value.attr)
    return out


def resolve(node, consts, other):
    """A static code for an expression, or None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        v = consts.get(node.id)
        if isinstance(v, tuple):
            v = other.get(v[1])
        return v if isinstance(v, str) else None
    if isinstance(node, ast.Attribute):
        return other.get(node.attr) or consts.get(node.attr) if isinstance(other.get(node.attr) or consts.get(node.attr), str) else None
    if isinstance(node, ast.Subscript):  # f"..."[:64].rstrip(":") and friends
        return resolve(node.value, consts, other)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("rstrip", "lower", "strip"):
        return resolve(node.func.value, consts, other)
    if isinstance(node, ast.JoinedStr):
        head = "".join(v.value for v in node.values if isinstance(v, ast.Constant))
        if head.endswith("_") and isinstance(node.values[-1], ast.FormattedValue):
            return f"{head}<arg>"  # f"cart_link_{reason}": the prefix, then a run-time name
        head = head.rstrip("_:").rstrip(":")
        return f"{head}:<arg>" if head else None
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_code" and node.args:
        prefix = resolve(node.args[0], consts, other)
        return f"{prefix}:<kind>:<status>" if prefix else None
    return None


def functions(tree):
    return {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def enclosing(tree, target):
    """The innermost function containing `target`."""
    best = None
    for fn in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
        if fn.lineno <= target.lineno <= (fn.end_lineno or fn.lineno) and (best is None or fn.lineno >= best.lineno):
            best = fn
    return best


def harvest(node, fn, funcs, consts, depth=0):
    """The static codes an expression can carry, strictly: a literal; each side of `x or "code"`; the argument of
    `_error_code(...)` / `str(...)` / `_cap(...)` (an upper-case partner literal lower-cased); a name's assignments in its
    function; both branches of `a if c else b`; the static returns of a module helper it calls. Nothing else (a dict key,
    an attribute or a subscript is never a code)."""
    found = set()
    if node is None or depth > 5:
        return found
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        v = node.value.lower() if node.value.isupper() else node.value
        if CODE_RE.match(v):
            found.add(v)
    elif isinstance(node, ast.JoinedStr):
        code = resolve(node, consts, {})
        if code and CODE_RE.match(code):
            found.add(code)
    elif isinstance(node, ast.BoolOp):
        for v in node.values:
            found |= harvest(v, fn, funcs, consts, depth + 1)
    elif isinstance(node, ast.IfExp):
        found |= harvest(node.body, fn, funcs, consts, depth + 1) | harvest(node.orelse, fn, funcs, consts, depth + 1)
    elif isinstance(node, ast.Name):
        if isinstance(consts.get(node.id), str):
            found.add(consts[node.id])
        for a in (n for n in ast.walk(fn) if isinstance(n, ast.Assign)) if fn is not None else ():
            if any(isinstance(t, ast.Name) and t.id == node.id for t in a.targets):
                found |= harvest(a.value, fn, funcs, consts, depth + 1)
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        name = node.func.id
        if name in ("_error_code", "str", "_cap") and node.args:
            found |= harvest(node.args[0], fn, funcs, consts, depth + 1)
        elif name in funcs and name.startswith("_") and name not in ("_move", "_still_ours"):
            callee = funcs[name]
            for ret in (r for r in ast.walk(callee) if isinstance(r, ast.Return) and r.value is not None):
                vals = ret.value.elts[:1] if isinstance(ret.value, ast.Tuple) else [ret.value]
                for v in vals:
                    found |= harvest(v, callee, funcs, consts, depth + 1)
    return found


def add(out, rail, state, code, dynamic, where):
    if code and CODE_RE.match(code):
        out[rail][state].add(code)
    else:
        dynamic.append(f"{rail}/{state} {where}")


def a2a(repo, sha, out, dynamic):
    other = constants(ast.parse(show(repo, sha, A2A_SHIPPING)))
    src = show(repo, sha, A2A_WORKER)
    tree = ast.parse(src)
    consts = constants(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = ast.unparse(node.func)
        kw = {k.arg: k.value for k in node.keywords if k.arg}
        if fn.endswith("_token_failed") and len(node.args) >= 3:
            add(out, "a2a", "failed", resolve(node.args[2], consts, other), dynamic, f"{A2A_WORKER}:{node.lineno}")
        elif fn.endswith(("_checkout_failed", "_cancel_checkout")) and len(node.args) >= 2 and not isinstance(node.args[1], ast.Name) or (
                fn.endswith(("_checkout_failed", "_cancel_checkout")) and len(node.args) >= 2 and resolve(node.args[1], consts, other)):
            add(out, "a2a", "failed", resolve(node.args[1], consts, other), dynamic, f"{A2A_WORKER}:{node.lineno}")
        elif "to_state" in kw:
            state = resolve(kw["to_state"], consts, other)
            if state not in FINAL:
                continue
            for k in ("last_error_code", "refusal_reason"):
                if k in kw:
                    add(out, "a2a", state, resolve(kw[k], consts, other), dynamic, f"{A2A_WORKER}:{node.lineno} {k}")
    # `ended = {"declined": ("failed", "vic_authorization_declined"), ...}`
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for v in node.values:
                if isinstance(v, ast.Tuple) and len(v.elts) == 2 and all(isinstance(e, ast.Constant) for e in v.elts):
                    state, code = v.elts[0].value, v.elts[1].value
                    if state in FINAL and isinstance(code, str):
                        add(out, "a2a", state, code, dynamic, f"{A2A_WORKER}:{v.lineno}")
    # The cancel / checkout-failed helpers' callers passing a module constant.
    for m in re.finditer(r"_cancel_checkout\(s, ([A-Z_]+)\)", src):
        add(out, "a2a", "failed", consts.get(m.group(1)), dynamic, f"{A2A_WORKER} _cancel_checkout")
    for m in re.finditer(r'_checkout_failed\(s, f"checkout_\{', src):
        statuses = re.search(r"_CHECKOUT_NOT_SUBMITTED = frozenset\(\{([^}]*)\}\)", src)
        for st in re.findall(r'"([a-z-]+)"', statuses.group(1) if statuses else ""):
            add(out, "a2a", "failed", "checkout_" + st.replace("-", "_"), dynamic, f"{A2A_WORKER} _CHECKOUT_NOT_SUBMITTED")
    # Price-ceiling refusals: CeilingRefused(CODE, refused=True) -> refused, else failed.
    for m in re.finditer(r"CeilingRefused\(([A-Z_]+), refused=(True|False)\)", src):
        add(out, "a2a", "refused" if m.group(2) == "True" else "failed", consts.get(m.group(1)), dynamic, f"{A2A_WORKER} CeilingRefused")
    # A dead card status: f"card_binding_{status.lower()}" over _DEAD_METHOD_STATUSES.
    dead = re.search(r"_DEAD_METHOD_STATUSES = \{([^}]*)\}", src)
    for st in re.findall(r'"([A-Z]+)"', dead.group(1) if dead else ""):
        add(out, "a2a", "failed", f"card_binding_{st.lower()}", dynamic, f"{A2A_WORKER} _DEAD_METHOD_STATUSES")
    # Their f-string forms, enumerated above from the statuses they are built from.
    for placeholder in ("card_binding:<arg>", "checkout:<arg>", "card_binding_<arg>", "checkout_<arg>"):
        out["a2a"]["failed"].discard(placeholder)
    ledger = show(repo, sha, A2A_LEDGER)
    for sql in re.findall(r"SET state = 'expired',(.*?)WHERE", ledger, re.S):
        for code in re.findall(r"(?:THEN|ELSE) '([a-z_]+)'", sql):
            add(out, "a2a", "expired", code, dynamic, f"{A2A_LEDGER} sweep")
    for sql in re.findall(r"SET state = 'failed',\s*last_error_code = :code", ledger):
        dynamic.append(f"a2a/failed {A2A_LEDGER} operator resolve (:code; operator_confirmed_not_charged, jobs/a2a_rail_operator.py)")
        add(out, "a2a", "failed", "operator_confirmed_not_charged", dynamic, "")


def reap(repo, sha, out, dynamic):
    src = show(repo, sha, REAP_SERVICE)
    tree = ast.parse(src)
    consts = constants(tree)
    funcs = functions(tree)
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and ast.unparse(node.func).endswith("_move")):
            continue
        state = next((a.value for a in node.args if isinstance(a, ast.Constant) and a.value in FINAL), None)
        if not state:
            continue
        kw = {k.arg: k.value for k in node.keywords if k.arg}
        fn = enclosing(tree, node)
        values = [(k, kw[k]) for k in ("last_error_code", "refusal_reason") if k in kw]
        # `**conflict` where `conflict = dict(evidence, last_error_code="...")`.
        for splat in (k.value for k in node.keywords if k.arg is None and isinstance(k.value, ast.Name)):
            for a in (n for n in ast.walk(fn) if isinstance(n, ast.Assign)) if fn else ():
                if any(isinstance(t, ast.Name) and t.id == splat.id for t in a.targets) and isinstance(a.value, ast.Call):
                    values += [(k.arg, k.value) for k in a.value.keywords if k.arg in ("last_error_code", "refusal_reason")]
        for k, value in values:
            code = resolve(value, consts, {})
            if code:
                add(out, "reap", state, code, dynamic, "")
                continue
            codes = harvest(value, fn, funcs, consts)
            for c in codes:
                add(out, "reap", state, c, dynamic, "")
            dynamic.append(f"reap/{state} {REAP_SERVICE}:{node.lineno} {k}" + (f" (static part: {', '.join(sorted(codes))})" if codes else ""))
    m = re.search(r"_QUOTE_REFUSAL_KINDS: Dict\[str, str\] = \{(.*?)\}", src, re.S)
    for code in set(re.findall(r':\s*"([a-z_]+)"', m.group(1) if m else "")):
        add(out, "reap", "refused", code, dynamic, "_QUOTE_REFUSAL_KINDS")
    # A `_row_scope` refusal is written as `refusal_reason=exc.reason` (quoting -> refused): its reasons.
    for name in REAP_SCOPE_FUNCTIONS:
        for sub in ast.walk(funcs[name]) if name in funcs else ():
            if isinstance(sub, ast.Call) and ast.unparse(sub.func).endswith("PurchaseRefused") and sub.args:
                add(out, "reap", "refused", resolve(sub.args[0], consts, {}), dynamic, f"{REAP_SERVICE} {name}")
    for name in REAP_VERDICT_HELPERS:
        fn = next((n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name), None)
        for ret in (r for r in ast.walk(fn) if isinstance(r, ast.Return)) if fn else ():
            # A `(refusal_reason, last_error_code)` tuple: both are written (the reason first).
            vals = ret.value.elts[:2] if isinstance(ret.value, ast.Tuple) else [ret.value]
            for v in vals:
                code = resolve(v, consts, {}) if v is not None else None
                if not code and v is not None:
                    codes = harvest(v, fn, funcs, consts)
                    for c in codes:
                        add(out, "reap", "refused", c, dynamic, name)
                    continue
                if code:
                    add(out, "reap", "refused", code.replace(":<arg>", ""), dynamic, name)
    # The quote verdict: `QuoteCheck(False, <refusal_reason>, <last_error_code>)` (positional or keyword), written by
    # the quoting step's `refused` move as `verdict.refusal_reason` / `verdict.last_error_code`.
    for sub in ast.walk(tree):
        if isinstance(sub, ast.Call) and ast.unparse(sub.func).endswith("QuoteCheck"):
            kw = {k.arg: k.value for k in sub.keywords if k.arg}
            ok = sub.args[0] if sub.args else kw.get("ok")
            if not (isinstance(ok, ast.Constant) and ok.value is False):
                continue
            for v in list(sub.args[1:3]) + [kw[k] for k in ("refusal_reason", "last_error_code") if k in kw]:
                add(out, "reap", "refused", resolve(v, consts, {}), dynamic, f"{REAP_SERVICE}:{sub.lineno} QuoteCheck")
    ledger = show(repo, sha, REAP_LEDGER)
    for state, body in re.findall(r"SET state = (?:CASE WHEN state = '[a-z_]+' THEN )?'(failed|expired)'(.*?)WHERE", ledger, re.S):
        for code in re.findall(r"last_error_code = (?:COALESCE\(last_error_code, )?'([a-z_]+)'", body):
            add(out, "reap", state, code, dynamic, f"{REAP_LEDGER} sweep")
    for both in re.findall(r"THEN 'expired' ELSE 'failed' END,\s*last_error_code = '([a-z_]+)'", ledger):
        add(out, "reap", "expired", both, dynamic, f"{REAP_LEDGER} contact re-entry")
        add(out, "reap", "failed", both, dynamic, f"{REAP_LEDGER} contact re-entry")
    recovery = show(repo, sha, REAP_RECOVERY)
    statuses = re.search(r'\{"COMPLETED":"completed", "FAILED":"failed", "EXPIRED":"expired"\}', recovery)
    if "manual_provider_" in recovery and statuses:
        add(out, "reap", "failed", "manual_provider_failed", dynamic, REAP_RECOVERY)
        add(out, "reap", "expired", "manual_provider_expired", dynamic, REAP_RECOVERY)
    for code in set(re.findall(r'refusal_reason="([a-z_]+)"', show(repo, sha, REAP_ROUTES))):
        add(out, "reap", "refused", code, dynamic, REAP_ROUTES)
    for raw in set(re.findall(r'reason=(f?"[^"]*")', show(repo, sha, REAP_CLIENT))):
        code = re.sub(r"\{[^}]*\}", "<arg>", raw.lstrip("f").strip('"'))
        add(out, "reap", "refused", code, dynamic, REAP_CLIENT)
    dynamic.append(f"reap/failed {REAP_SERVICE} _error_code(<partner code>): the partner's own codes")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True, help="a pivota-backend checkout (read with git show only)")
    ap.add_argument("--sha", required=True)
    ap.add_argument("--contract", help="HOOK: a backend contract JSON of final codes per rail and state, in the repo")
    args = ap.parse_args()
    sha = subprocess.run(["git", "-C", args.repo, "rev-parse", "--short=9", args.sha], check=True, capture_output=True, text=True).stdout.strip()
    out = {rail: {state: set() for state in FINAL} for rail in ("a2a", "reap")}
    dynamic = []
    a2a(args.repo, sha, out, dynamic)
    reap(args.repo, sha, out, dynamic)
    if args.contract:
        contract = json.loads(show(args.repo, sha, args.contract))
        for rail in ("a2a", "reap"):
            for state in FINAL:
                out[rail][state].update(contract.get(rail, {}).get(state, []))
    doc = {
        "backend_sha": sha,
        "generated_by": "scripts/agenpas/extract_backend_final_codes.py",
        "note": "`<arg>` / `<kind>` / `<status>` stand for a run-time segment; every segment is read.",
        **{rail: {state: sorted(codes) for state, codes in by.items()} for rail, by in out.items()},
        "dynamic": sorted(set(d for d in dynamic if d)),
    }
    json.dump(doc, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
