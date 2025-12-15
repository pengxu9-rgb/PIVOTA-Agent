#!/usr/bin/env python3
import json
import os
import re
import statistics
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests


HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CASES_PATH = os.path.join(HERE, "cases.json")


@dataclass
class CaseResult:
  case_id: str
  passed: bool
  error: Optional[str] = None
  latency_ms: Optional[float] = None


def _load_cases(path: str = DEFAULT_CASES_PATH) -> Dict[str, Any]:
  with open(path, "r", encoding="utf-8") as f:
    return json.load(f)


def _tee_like(text: str) -> bool:
  if not text:
    return False
  t = text.lower()
  compact = re.sub(r"[^a-z0-9]+", "", t)
  if compact == "tee":
    return True
  if "tshirt" in compact:
    return True
  if re.search(r"\btees?\b", t):
    return True
  if re.search(r"\bt\s*-?\s*shirts?\b", t):
    return True
  for es_token in ("camiseta", "camisetas", "playera", "playeras"):
    if es_token in t:
      return True
  return False


def _extract_category_tokens(product: Dict[str, Any]) -> str:
  parts: List[str] = []
  title = product.get("title") or ""
  if title:
    parts.append(str(title))
  ptype = product.get("product_type") or ""
  if ptype:
    parts.append(str(ptype))
  category = product.get("category")
  if isinstance(category, dict):
    path = category.get("path")
    if isinstance(path, list):
      parts.extend([str(x) for x in path])
  tags = product.get("tags")
  if isinstance(tags, list):
    parts.extend([str(x) for x in tags])
  return " ".join(parts).lower()


def _has_forbidden_category(product: Dict[str, Any], forbidden: List[str]) -> bool:
  blob = _extract_category_tokens(product)
  for cat in forbidden:
    if not cat:
      continue
    if cat.lower() in blob:
      return True
  return False


def _contains_any_category(product: Dict[str, Any], required: List[str]) -> bool:
  blob = _extract_category_tokens(product)
  for cat in required:
    if not cat:
      continue
    if cat.lower() in blob:
      return True
  return False


def _has_dirty_title(product: Dict[str, Any], dirty_titles: List[str]) -> bool:
  title = (product.get("title") or "").strip()
  if not title:
    return False
  for dirty in dirty_titles:
    if title == dirty:
      return True
  return False


def _reply_matches(reply: Optional[str], patterns: List[str]) -> bool:
  if not reply:
    return False
  t = reply.lower()
  return any(p.lower() in t for p in patterns if p)


def _reply_has_prompt_or_disclaimer(reply: Optional[str]) -> bool:
  """
  For cases with reply_should_prompt_for_query=true, require that the reply:
  - exists and is non-trivial, and
  - contains either prompt-style language (asking for more info/link/photo)
    or disclaimer-style language (similar/inspired/not exact).

  This keeps the JSON schema unchanged while making disclaimers testable.
  """
  if not reply:
    return False
  t = str(reply).lower()
  if len(t.strip()) < 3:
    return False

  prompt_keywords = [
    "share", "send", "link", "photo", "picture", "image", "screenshot",
    "tell me", "describe", "more detail", "more details",
    "mas detalle", "más detalle", "mas detalles", "más detalles",
    "cuentame", "cuéntame", "ensename", "enséñame", "muestrame", "muéstrame",
  ]
  disclaimer_keywords = [
    "similar", "inspired",
    "not exact", "not an exact match",
    "can't guarantee exact", "cant guarantee exact", "cannot guarantee exact",
    "no puedo garantizar", "no es exacto", "no exacto", "no exacta",
  ]

  return any(kw in t for kw in prompt_keywords + disclaimer_keywords)


def _enforce_expectations(
  case: Dict[str, Any],
  status_code: int,
  body: Dict[str, Any],
  latency_ms: float,
) -> None:
  exp = case.get("expect") or {}
  cid = case.get("id", "<unknown>")

  products = body.get("products") or []
  reply = body.get("reply")

  # HTTP status handling for boundary cases
  allowed_status = exp.get("allow_http_status")
  if allowed_status is not None:
    if status_code not in allowed_status:
      raise AssertionError(f"{cid}: status_code {status_code} not in {allowed_status}")
    if 200 in allowed_status and status_code == 200:
      if exp.get("if_200_then_products_should_be_empty") and products:
        raise AssertionError(f"{cid}: expected empty products for HTTP 200, got {len(products)}")
      if exp.get("reply_should_prompt_for_query"):
        if not _reply_has_prompt_or_disclaimer(reply):
          raise AssertionError(f"{cid}: reply_should_prompt_for_query but reply missing or lacks prompt/disclaimer language")
    return

  # Generic status check
  if status_code != 200:
    raise AssertionError(f"{cid}: expected HTTP 200, got {status_code}")

  max_products = exp.get("max_products")
  if max_products is not None:
    if len(products) > max_products:
      raise AssertionError(f"{cid}: len(products)={len(products)} > max_products={max_products}")

  allow_empty = bool(exp.get("allow_empty", False))
  if not allow_empty and not products:
    raise AssertionError(f"{cid}: expected non-empty products but got []")

  # Field presence
  required_fields = exp.get("required_fields_each_product") or []
  for idx, p in enumerate(products):
    for field in required_fields:
      if field not in p or p[field] in (None, ""):
        raise AssertionError(f"{cid}: product[{idx}] missing required field '{field}'")

  # Dirty title guard
  dirty_titles = exp.get("must_not_contain_dirty_titles") or []
  for idx, p in enumerate(products):
    if _has_dirty_title(p, dirty_titles):
      raise AssertionError(f"{cid}: product[{idx}] has dirty placeholder title '{p.get('title')}'")

  # Category-based checks
  must_all_be_tee = bool(exp.get("must_all_be_tee", False))
  if must_all_be_tee:
    for idx, p in enumerate(products):
      title = p.get("title") or ""
      ptype = p.get("product_type") or ""
      blob = f"{title} {ptype}"
      if not _tee_like(blob):
        raise AssertionError(f"{cid}: product[{idx}] is not tee-like: '{title}' / '{ptype}'")

  forbidden_cats = exp.get("must_not_contain_categories") or []
  if forbidden_cats:
    for idx, p in enumerate(products):
      if _has_forbidden_category(p, forbidden_cats):
        raise AssertionError(f"{cid}: product[{idx}] matched forbidden category; title='{p.get('title')}', product_type='{p.get('product_type')}'")

  if exp.get("must_not_be_all_tee"):
    if products and all(_tee_like((p.get("title") or "") + " " + (p.get("product_type") or "")) for p in products):
      raise AssertionError(f"{cid}: must_not_be_all_tee but all products look like tees")

  required_cats = exp.get("must_contain_any_category") or []
  if required_cats and products:
    if not any(_contains_any_category(p, required_cats) for p in products):
      raise AssertionError(f"{cid}: expected at least one product matching any of {required_cats}")

  # Soft expectations on top-N patterns
  soft = exp.get("soft_expect_topn_match_any")
  if soft:
    n = int(soft.get("n", 10))
    min_match = int(soft.get("min_match_count", 1))
    patterns = soft.get("patterns_any") or []
    top = products[:n]
    matches = 0
    for p in top:
      text = " ".join(
        str(x)
        for x in [
          p.get("title") or "",
          p.get("description") or "",
          p.get("product_type") or "",
        ]
      ).lower()
      if any(pat.lower() in text for pat in patterns if pat):
        matches += 1
    if matches < min_match:
      raise AssertionError(f"{cid}: soft_expect_topn_match_any failed; matches={matches}, expected>={min_match}")

  # Reply content checks
  if exp.get("reply_must_not_match"):
    patterns = exp["reply_must_not_match"]
    if _reply_matches(reply, patterns):
      raise AssertionError(f"{cid}: reply contains forbidden pattern in {patterns}")

  if exp.get("reply_should_prompt_for_query"):
    if not _reply_has_prompt_or_disclaimer(reply):
      raise AssertionError(f"{cid}: reply_should_prompt_for_query but reply missing or lacks prompt/disclaimer language")

  # Deduplication
  if exp.get("no_duplicate_products"):
    seen = set()
    for idx, p in enumerate(products):
      pid = str(p.get("id") or p.get("product_id") or "")
      platform = str(p.get("platform") or p.get("merchant_id") or "")
      key = (platform, pid)
      if key in seen:
        raise AssertionError(f"{cid}: duplicate product at index {idx} (platform={platform}, id={pid})")
      seen.add(key)

  # Perf thresholds (per-call check)
  perf = exp.get("perf_threshold_ms")
  if perf:
    p95 = perf.get("p95")
    p99 = perf.get("p99")
    if p95 is not None and latency_ms > float(p95) * 1.5:
      raise AssertionError(f"{cid}: latency {latency_ms:.1f}ms significantly exceeds p95={p95}ms hint")
    if p99 is not None and latency_ms > float(p99) * 2.0:
      raise AssertionError(f"{cid}: latency {latency_ms:.1f}ms significantly exceeds p99={p99}ms hint")


def run_cases(cases_path: str = DEFAULT_CASES_PATH) -> None:
  cfg = _load_cases(cases_path)
  defaults = cfg.get("defaults") or {}
  default_endpoint = defaults.get("endpoint")
  default_operation = defaults.get("operation", "find_products_multi")
  default_creator = defaults.get("creator") or {}

  endpoint = os.getenv("PIVOTA_AGENT_ENDPOINT", default_endpoint)
  if not endpoint:
    raise SystemExit("Missing endpoint: set PIVOTA_AGENT_ENDPOINT or defaults.endpoint in cases.json")

  # Allow overriding base URL but keep path consistent if needed.
  if not endpoint.endswith("/agent/shop/v1/invoke"):
    if endpoint.endswith("/"):
      endpoint = endpoint.rstrip("/")
    endpoint = endpoint + "/agent/shop/v1/invoke"

  print(f"Using endpoint: {endpoint}")

  results: List[CaseResult] = []
  perf_latencies: List[float] = []

  for case in cfg.get("cases", []):
    cid = case.get("id", "<unknown>")
    desc = case.get("desc", "")
    expect = case.get("expect") or {}
    intent = expect.get("intent")

    req = case.get("request") or {}
    query = req.get("query", "")
    limit = int(req.get("limit", 50))
    user_id = req.get("user_id") or ""
    recent_queries = req.get("recent_queries") or []

    payload = {
      "operation": default_operation,
      "payload": {
        "search": {
          "query": query,
          "page": 1,
          "limit": limit,
        },
        "user": {
          "id": user_id,
          "recent_queries": recent_queries,
        },
        "metadata": {
          "creator_id": default_creator.get("creator_id"),
          "creator_name": default_creator.get("creator_name"),
          "source": "tee-intent-test",
          "trace_id": cid,
        },
      },
    }

    print(f"\n=== Case {cid} ({intent}) ===")
    print(desc)

    attempts = 3
    last_error: Optional[str] = None

    for attempt in range(1, attempts + 1):
      started = time.perf_counter()
      try:
        resp = requests.post(
          endpoint,
          json=payload,
          timeout=10,
        )
        latency_ms = (time.perf_counter() - started) * 1000.0

        # Retry on transient 5xx errors (except on last attempt).
        if resp.status_code >= 500 and resp.status_code < 600 and attempt < attempts:
          print(f" -> HTTP {resp.status_code} on attempt {attempt}, retrying...")
          last_error = f"HTTP {resp.status_code}"
          time.sleep(0.5 * attempt)
          continue

        try:
          body = resp.json()
        except Exception:
          body = {}

        try:
          _enforce_expectations(case, resp.status_code, body, latency_ms)
          print(f" -> PASS ({latency_ms:.1f} ms)")
          results.append(CaseResult(case_id=cid, passed=True, latency_ms=latency_ms))
          if expect.get("intent") == "perf":
            perf_latencies.append(latency_ms)
          break
        except AssertionError as e:
          print(f" -> FAIL: {e}")
          results.append(CaseResult(case_id=cid, passed=False, error=str(e), latency_ms=latency_ms))
          break
      except requests.exceptions.RequestException as e:
        latency_ms = (time.perf_counter() - started) * 1000.0
        last_error = str(e)
        if attempt < attempts:
          print(f" -> ERROR attempt {attempt}/{attempts}: {e}; retrying...")
          time.sleep(0.5 * attempt)
          continue
        print(f" -> ERROR calling endpoint after {attempts} attempts: {e}")
        results.append(CaseResult(case_id=cid, passed=False, error=str(e), latency_ms=latency_ms))
        break

  passed = sum(1 for r in results if r.passed)
  failed = len(results) - passed

  print("\n=== Summary ===")
  print(f"Total cases: {len(results)} | Passed: {passed} | Failed: {failed}")

  if perf_latencies:
    perf_sorted = sorted(perf_latencies)
    if len(perf_sorted) >= 20:
      p95_val = statistics.quantiles(perf_sorted, n=20)[18]
    else:
      # With small samples, approximate p95 as the max latency observed.
      p95_val = perf_sorted[-1]
    print(
      f"Perf latencies (ms): min={perf_sorted[0]:.1f}, "
      f"p95≈{p95_val:.1f} "
      f"max={perf_sorted[-1]:.1f}"
    )

  if failed:
    raise SystemExit(1)
  # Do not raise when everything passes; exit code 0 by default.


if __name__ == "__main__":
  path = os.environ.get("TEE_CASES_PATH", DEFAULT_CASES_PATH)
  run_cases(path)
