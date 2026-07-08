#!/usr/bin/env python3
"""Frontier-citation demand proof — reproducible, zero-auth, stdlib-only.

Proves the supply->read->cite path end to end against LIVE prod, the way a
frontier agent (ChatGPT / Claude) reaches Pivota:

  1. TOOL-CALL   POST agent.pivota.cc/api/gateway (auth:none per ai-plugin.json)
                 with operation=find_products_multi -> real products + citable
                 pivota_canonical_url on each.
  2. READ+CITE   GET a canonical PDP as a crawler -> parse schema.org Product
                 JSON-LD -> extract grounded ingredient-benefit PropertyValue
                 claims (the substrate an agent cites).
  3. DEMAND      report whether the page is indexed in the wild (informational;
                 `site:agent.pivota.cc` in a browser is the human check).

No API key, no OAuth, no repo dependency. Run:
    python3 scripts/frontier_citation_proof.py "niacinamide serum for dark spots"

Exit 0 = both the tool-call and a citable-claims PDP were proven; 1 = a gap.
This is the *controllable* half of the proof. The remaining half (an agent in a
consumer app literally calling + attributing Pivota) is the connector turn-up in
docs/frontier_citation_proof_experiment.md (Path A: ChatGPT GPT Action, ~10 min).
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
import html as htmlmod

BASE = "https://agent.pivota.cc"
UA = "Mozilla/5.0 (compatible; PivotaCitationProof/1.0)"


def _post(path: str, body: dict, timeout: int = 30):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"User-Agent": UA, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8", "replace"))


def _get(url: str, timeout: int = 25) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def prove_tool_call(query: str) -> list[dict]:
    """Step 1 — the unauthenticated agent tool-call returns citable products."""
    print(f"\n[1] TOOL-CALL  POST {BASE}/api/gateway  (auth:none)")
    print(f"    operation=find_products_multi  query={query!r}")
    st, d = _post(
        "/api/gateway",
        {"operation": "find_products_multi", "payload": {"search": {"query": query, "limit": 5}}},
    )
    products = d.get("products") or []
    citable = [p for p in products if p.get("pivota_canonical_url")]
    print(f"    -> HTTP {st}  status={d.get('status')}  products={len(products)}  with_citable_url={len(citable)}")
    for p in products[:5]:
        title = (p.get("title") or p.get("name") or "?")[:48]
        print(f"       - {title:48}  {p.get('pivota_canonical_url') or '(no canonical url)'}")
    if st != 200 or not citable:
        print("    FAIL: gateway did not return citable products")
    return citable


def _product_jsonld(html: str) -> list[dict]:
    out = []
    for block in re.findall(r"application/ld\+json[^>]*>(.*?)</script>", html, re.S | re.I):
        for candidate in (block, htmlmod.unescape(block)):
            try:
                data = json.loads(candidate)
            except Exception:
                continue

            def walk(o):
                if isinstance(o, dict):
                    if o.get("@type") == "Product":
                        out.append(o)
                    for v in o.values():
                        walk(v)
                elif isinstance(o, list):
                    for x in o:
                        walk(x)

            walk(data)
            break
    return out


def prove_citable_claims(canonical_urls: list[str]) -> bool:
    """Step 2 — a crawler can read grounded ingredient claims from a PDP's JSON-LD."""
    print(f"\n[2] READ+CITE  fetch canonical PDP(s) as a crawler, parse schema.org JSON-LD")
    for url in canonical_urls:
        try:
            st, html = _get(url)
        except Exception as e:
            print(f"    {url} -> ERROR {type(e).__name__}")
            continue
        if len(html) < 40000:
            print(f"    {url} -> THIN page ({len(html)}B, likely not fully rendered) — skip")
            continue
        products = _product_jsonld(html)
        claims = []
        for prod in products:
            for prop in prod.get("additionalProperty") or []:
                if not isinstance(prop, dict):
                    continue
                name = str(prop.get("name") or "")
                val = prop.get("value")
                if isinstance(val, dict):
                    val = val.get("value") or val.get("name") or ""
                val = str(val or "")
                # A grounded ingredient-benefit claim is a full sentence; variant
                # metadata (volume/size/shade/color/scent/finish) is a short label.
                # Filter on both the name denylist AND a substantive-value length.
                if name.lower() in ("volume", "size", "shade", "color", "colour", "scent", "finish", "format"):
                    continue
                if len(val) >= 40:
                    claims.append((name, val))
        if claims:
            print(f"    {url}")
            print(f"    -> {len(html)}B SSR HTML, Product JSON-LD parsed, {len(claims)} grounded claims. A frontier agent would cite:")
            for name, val in claims[:6]:
                print(f'       • "{name}: {val[:150]}"')
            return True
        print(f"    {url} -> page OK but NO structured claims (claims stranded in DB/prose) — trying next")
    print("    FAIL: no citable structured claims found in the sampled PDPs")
    return False


def report_demand() -> None:
    """Step 3 — informational: is the citable supply discoverable in the wild?"""
    print(f"\n[3] DEMAND (informational)")
    print(f"    Human check: search  site:agent.pivota.cc  on Google.")
    print(f"    As of 2026-07-08 this returns 0 indexed pages -> no web-search agent")
    print(f"    can discover/cite these pages yet. Fix = submit {BASE}/sitemap.xml in")
    print(f"    Google Search Console (docs/gsc_sitemap_submission_runbook.md).")


def main() -> int:
    query = sys.argv[1] if len(sys.argv) > 1 else "niacinamide serum for dark spots"
    print("=" * 78)
    print("FRONTIER-CITATION DEMAND PROOF  (live prod, zero-auth)")
    print("=" * 78)
    citable = prove_tool_call(query)
    urls = [p["pivota_canonical_url"] for p in citable][:8]
    cited = prove_citable_claims(urls) if urls else False
    report_demand()
    print("\n" + "-" * 78)
    tool_ok = bool(citable)
    print(f"RESULT: tool-call path {'PASS' if tool_ok else 'FAIL'} | citable-claims path {'PASS' if cited else 'FAIL'}")
    print("The read->cite plumbing is proven where both PASS. Turning this into an")
    print("agent that CALLS + ATTRIBUTES Pivota is the connector turn-up (Path A).")
    print("-" * 78)
    return 0 if (tool_ok and cited) else 1


if __name__ == "__main__":
    raise SystemExit(main())
