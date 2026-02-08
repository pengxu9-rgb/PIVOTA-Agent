#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

CASES_FILE="${CASES_FILE:-}"
DEFAULT_SEED_CASES="tests/cases.jsonl"
SEED_CASES="${SEED_CASES:-${CASES_FILE:-$DEFAULT_SEED_CASES}}"
GENERATED_CASES="${GENERATED_CASES:-tests/generated_cases.jsonl}"
MERGED_CASES="${MERGED_CASES:-out/cases_merged.jsonl}"
RESULTS_PATH="${RESULTS_PATH:-out/results.jsonl}"

if [[ -z "${GENERATE_CASES+x}" ]]; then
  if [[ "$SEED_CASES" == "$DEFAULT_SEED_CASES" ]]; then
    GENERATE_CASES="true"
  else
    GENERATE_CASES="false"
  fi
fi
MAX_GENERATED_CASES="${MAX_GENERATED_CASES:-120}"
if [[ -z "${MIN_SEED_CASES+x}" ]]; then
  if [[ "$SEED_CASES" == "$DEFAULT_SEED_CASES" ]]; then
    MIN_SEED_CASES="40"
  else
    MIN_SEED_CASES="1"
  fi
fi

AURORA_API_URL="${AURORA_API_URL:-http://127.0.0.1:8787/v1/chat}"
AURORA_API_KEY="${AURORA_API_KEY:-}"
AURORA_MODEL="${AURORA_MODEL:-aurora-beauty}"
LOCALE="${LOCALE:-zh-CN}"
CONCURRENCY="${CONCURRENCY:-5}"
TIMEOUT_SEC="${TIMEOUT_SEC:-35}"
MAX_RETRIES="${MAX_RETRIES:-3}"
ROUTE_API_MAP_JSON="${ROUTE_API_MAP_JSON:-}"

mkdir -p out tests

if [[ ! -f "$SEED_CASES" ]]; then
  echo "Missing seed file: $SEED_CASES" >&2
  exit 1
fi

seed_count="$(wc -l < "$SEED_CASES" | tr -d ' ')"
if [[ "$seed_count" -lt "$MIN_SEED_CASES" ]]; then
  echo "Seed cases must be >=$MIN_SEED_CASES, got $seed_count in $SEED_CASES" >&2
  exit 1
fi

if [[ "$GENERATE_CASES" == "true" ]]; then
  python3 - "$SEED_CASES" "$GENERATED_CASES" "$MAX_GENERATED_CASES" <<'PY'
import itertools
import json
import random
import sys
from pathlib import Path

seed_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
target = max(120, int(sys.argv[3]))

seeds = []
for line in seed_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line:
        continue
    seeds.append(json.loads(line))

skin_profiles = [
    {"skin_type": "oily", "sensitivity": "low", "barrier": "healthy"},
    {"skin_type": "dry", "sensitivity": "medium", "barrier": "impaired"},
    {"skin_type": "combination", "sensitivity": "medium", "barrier": "healthy"},
    {"skin_type": "sensitive", "sensitivity": "high", "barrier": "impaired"},
    {"skin_type": "normal", "sensitivity": "low", "barrier": "healthy"},
]
goals = [
    ("acne", "I have recurring acne and clogged pores. What should I adjust this week?"),
    ("redness", "My cheeks look red and sting sometimes. Can you suggest a safer routine?"),
    ("brightening", "I want brighter skin and less post-acne marks without irritation."),
    ("antiaging", "I want anti-aging results but still keep my barrier stable."),
    ("pores", "My nose pores look enlarged lately. How should I optimize my steps?"),
]
environments = [
    ("snow", {"city": "Montreal", "weather": "snow", "uv_index": 2, "travel": "none"}),
    ("humid", {"city": "Singapore", "weather": "humid_hot", "uv_index": 9, "travel": "none"}),
    ("flight", {"city": "Paris", "weather": "cold_dry", "uv_index": 4, "travel": "flight"}),
    ("mask", {"city": "Tokyo", "weather": "mixed", "uv_index": 5, "travel": "mask_commute"}),
]
ingredient_prompts = [
    ("retinoid_acid", "Can I use retinoid and AHA in the same night?"),
    ("vitc_niacinamide", "Can vitamin C and niacinamide be used together in my AM routine?"),
    ("bpo_retinoid", "How should I separate benzoyl peroxide and retinoid safely?"),
    ("azelaic", "How often should I start azelaic acid if I get irritation easily?"),
]
tone_prompts = [
    ("anxious", "I am anxious and want quick results, but I don't want to damage my skin."),
    ("budget", "My monthly budget is limited. Can you keep this practical and affordable?"),
    ("gentle", "Please keep the plan gentle and realistic. I can only do 3-4 steps."),
]
langs = ["EN", "CN"]

expected_base = [
    "mentions_steps",
    "mentions_frequency",
    "includes_empowerment",
    "avoids_overclaim",
]

def _zh(text: str) -> str:
    mapping = {
        "I have recurring acne and clogged pores. What should I adjust this week?": "我最近反复长痘和闭口，这周应该怎么调整？",
        "My cheeks look red and sting sometimes. Can you suggest a safer routine?": "我两颊会泛红刺痛，能给我更稳妥的方案吗？",
        "I want brighter skin and less post-acne marks without irritation.": "我想提亮并淡化痘印，但不想刺激皮肤。",
        "I want anti-aging results but still keep my barrier stable.": "我想抗老，但也要把屏障维持稳定。",
        "My nose pores look enlarged lately. How should I optimize my steps?": "最近鼻子毛孔明显，步骤要怎么优化？",
        "Can I use retinoid and AHA in the same night?": "维A和AHA能同晚叠加吗？",
        "Can vitamin C and niacinamide be used together in my AM routine?": "早上维C和烟酰胺能一起用吗？",
        "How should I separate benzoyl peroxide and retinoid safely?": "过氧化苯甲酰和维A怎么错开更安全？",
        "How often should I start azelaic acid if I get irritation easily?": "容易刺激的话壬二酸该怎么起步频率？",
        "I am anxious and want quick results, but I don't want to damage my skin.": "我有点焦虑想快点见效，但不想把皮肤搞坏。",
        "My monthly budget is limited. Can you keep this practical and affordable?": "我月预算有限，请给我实用且省钱的方案。",
        "Please keep the plan gentle and realistic. I can only do 3-4 steps.": "请方案温和一点，我每天只能做3-4步。",
    }
    return mapping.get(text, text)

generated = []
seen = set()
for i, combo in enumerate(
    itertools.product(skin_profiles, goals, environments, ingredient_prompts, tone_prompts, langs),
    start=1,
):
    if len(generated) >= target:
        break
    skin, goal_pair, env_pair, ing_pair, tone_pair, lang = combo
    goal_tag, goal_msg = goal_pair
    env_tag, env = env_pair
    ing_tag, ing_msg = ing_pair
    tone_tag, tone_msg = tone_pair
    case_id = f"gen_{i:04d}_{goal_tag}_{ing_tag}_{env_tag}_{tone_tag}_{lang.lower()}"
    if case_id in seen:
        continue
    seen.add(case_id)
    user_msg_parts = [goal_msg, ing_msg, tone_msg]
    user_msg = " ".join(user_msg_parts)
    if lang == "CN":
        user_msg = " ".join(_zh(x) for x in user_msg_parts)
    expected = list(expected_base)
    if ing_tag in {"retinoid_acid", "bpo_retinoid"}:
        expected += ["warns_overexfoliation", "warns_irritation_pause", "mentions_sunscreen"]
    if env_tag in {"snow", "humid", "flight", "mask"}:
        expected += ["mentions_weather_adjustment"]
    if tone_tag == "anxious":
        expected += ["includes_empathy"]
    if tone_tag == "budget":
        expected += ["mentions_budget_options"]
    generated.append(
        {
            "case_id": case_id,
            "tags": ["generated", lang.lower(), goal_tag, ing_tag, env_tag, tone_tag],
            "context": {
                "skin_profile": skin,
                "environment": env,
                "preferences": {
                    "fragrance_free": skin["sensitivity"] == "high",
                    "budget": "low" if tone_tag == "budget" else "mid",
                },
            },
            "messages": [{"role": "user", "content": user_msg}],
            "expected_assertions": sorted(set(expected)),
        }
    )

random.Random(7).shuffle(generated)
out_path.parent.mkdir(parents=True, exist_ok=True)
with out_path.open("w", encoding="utf-8") as f:
    for item in generated[:target]:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")
print(out_path)
print(f"generated_cases={min(len(generated), target)}")
PY
else
  : > "$GENERATED_CASES"
fi

python3 - "$SEED_CASES" "$GENERATED_CASES" "$MERGED_CASES" <<'PY'
import json
import sys
from pathlib import Path

seed_path = Path(sys.argv[1])
gen_path = Path(sys.argv[2])
out_path = Path(sys.argv[3])

merged = []
seen = set()
for p in (seed_path, gen_path):
    if not p.exists():
        continue
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        cid = str(obj.get("case_id") or "").strip()
        if not cid or cid in seen:
            continue
        seen.add(cid)
        merged.append(obj)

out_path.parent.mkdir(parents=True, exist_ok=True)
with out_path.open("w", encoding="utf-8") as f:
    for obj in merged:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")
print(out_path)
print(f"merged_cases={len(merged)}")
PY

python3 - "$MERGED_CASES" "$RESULTS_PATH" <<'PY'
import concurrent.futures
import json
import os
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests

cases_path = Path(os.sys.argv[1])
out_path = Path(os.sys.argv[2])

api_url = os.environ.get("AURORA_API_URL", "http://127.0.0.1:8787/v1/chat")
api_key = os.environ.get("AURORA_API_KEY", "")
locale = os.environ.get("LOCALE", "zh-CN")
timeout_s = float(os.environ.get("TIMEOUT_SEC", "35"))
concurrency = max(1, int(os.environ.get("CONCURRENCY", "5")))
max_retries = max(0, int(os.environ.get("MAX_RETRIES", "3")))
route_api_map_raw = os.environ.get("ROUTE_API_MAP_JSON", "").strip()
include_messages = os.environ.get("INCLUDE_MESSAGES", "true").lower() == "true"
embed_context_hints = os.environ.get("EMBED_CONTEXT_HINTS", "false").lower() == "true"
profile_bootstrap = os.environ.get("PROFILE_BOOTSTRAP", "true").lower() == "true"
try:
    route_api_map = json.loads(route_api_map_raw) if route_api_map_raw else {}
except Exception:
    route_api_map = {}
if not isinstance(route_api_map, dict):
    route_api_map = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_assistant_text(payload: Dict[str, Any]) -> str:
    assistant = payload.get("assistant_message")
    if isinstance(assistant, dict) and isinstance(assistant.get("content"), str):
        return assistant.get("content", "")
    if isinstance(payload.get("answer"), str):
        return payload.get("answer", "")
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0] if isinstance(choices[0], dict) else {}
        message = first.get("message") if isinstance(first, dict) else None
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message.get("content", "")
        if isinstance(first.get("text"), str):
            return first.get("text", "")
    return ""


def _extract_card_types(payload: Dict[str, Any]) -> List[str]:
    cards = payload.get("cards")
    if not isinstance(cards, list):
        return []
    out: List[str] = []
    for c in cards:
        if isinstance(c, dict) and isinstance(c.get("type"), str):
            out.append(c["type"])
    return out


def _extract_usage(payload: Dict[str, Any]) -> Dict[str, Optional[int]]:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        choices = payload.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            usage = choices[0].get("usage")
    if not isinstance(usage, dict):
        return {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None}
    def _int_or_none(x: Any) -> Optional[int]:
        try:
            return int(x)
        except Exception:
            return None
    return {
        "prompt_tokens": _int_or_none(usage.get("prompt_tokens")),
        "completion_tokens": _int_or_none(usage.get("completion_tokens")),
        "total_tokens": _int_or_none(usage.get("total_tokens")),
    }


def _normalize_language(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"cn", "zh", "zh-cn", "zh_cn", "zh-hans"}:
        return "CN"
    if raw in {"en", "en-us", "en_us", "en-gb", "en_gb"}:
        return "EN"
    if "zh" in raw or "cn" in raw:
        return "CN"
    if "en" in raw:
        return "EN"
    return "CN"


def _primary_user_message(msg_list: List[Dict[str, Any]], fallback: str = "") -> str:
    for m in reversed(msg_list):
        if isinstance(m, dict) and str(m.get("role") or "").lower() == "user":
            content = str(m.get("content") or "").strip()
            if content:
                return content
    return fallback


def _context_hint(case: Dict[str, Any]) -> str:
    if not embed_context_hints:
        return ""
    ctx = case.get("context")
    if not isinstance(ctx, dict):
        return ""
    parts: List[str] = []
    skin = ctx.get("skin_profile")
    if isinstance(skin, dict):
        skin_type = skin.get("skin_type")
        concerns = skin.get("concerns")
        if skin_type:
            parts.append(f"skin_type={skin_type}")
        if isinstance(concerns, list) and concerns:
            parts.append("concerns=" + ",".join(str(x) for x in concerns[:3]))
    prefs = ctx.get("preferences")
    if isinstance(prefs, dict):
        budget = prefs.get("budget")
        fragrance = prefs.get("fragrance_free")
        if budget:
            parts.append(f"budget={budget}")
        if fragrance is True:
            parts.append("fragrance_free=true")
    env = ctx.get("environment")
    if isinstance(env, dict):
        weather = env.get("weather") or env.get("forecast")
        uv = env.get("uv_index")
        if weather:
            parts.append(f"weather={weather}")
        if uv is not None:
            parts.append(f"uv={uv}")
    if not parts:
        return ""
    return "User context: " + " | ".join(parts) + "\n"


def _build_payload(case: Dict[str, Any]) -> Dict[str, Any]:
    msg_list = case.get("messages")
    if not isinstance(msg_list, list) or not msg_list:
        msg_list = [{"role": "user", "content": str(case.get("prompt") or "").strip()}]
    language = _normalize_language(case.get("language") or locale)
    message = _primary_user_message(msg_list, fallback=str(case.get("prompt") or "").strip())
    req: Dict[str, Any] = {
        "message": (_context_hint(case) + message).strip(),
        "language": language,
        "session": {"state": "idle"},
    }
    if include_messages:
        req["messages"] = msg_list
    if isinstance(case.get("action"), dict):
        req["action"] = case["action"]
    if case.get("client_state") is not None:
        req["client_state"] = case.get("client_state")
    if isinstance(case.get("session"), dict):
        req["session"] = case["session"]
    if case.get("anchor_product_id"):
        req["anchor_product_id"] = case.get("anchor_product_id")
    return req


def _resolve_url(base_url: str, api_path: str, route: str) -> str:
    p = (api_path or "").strip()
    if not p and route:
        mapped = route_api_map.get(route)
        if isinstance(mapped, str) and mapped.strip():
            p = mapped
    if not p:
        return base_url
    if p.startswith("http://") or p.startswith("https://"):
        return p
    return base_url.rstrip("/") + "/" + p.lstrip("/")


def _entry_route(case: Dict[str, Any]) -> str:
    ctx = case.get("context")
    if isinstance(ctx, dict) and isinstance(ctx.get("entry_route"), str):
        return str(ctx.get("entry_route"))
    tags = case.get("tags")
    if isinstance(tags, list):
        for t in tags:
            if isinstance(t, str) and t.startswith("route_"):
                return t.replace("route_", "", 1)
    return "unknown"


def _headers(case_id: str) -> Dict[str, str]:
    uid = re.sub(r"[^a-zA-Z0-9_-]", "_", case_id)[:80] or "unknown_case"
    h = {
        "Content-Type": "application/json",
        "X-Aurora-UID": f"batch_{uid}",
    }
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
        h["X-API-Key"] = api_key
    return h


def _profile_update_url(request_url: str) -> str:
    parsed = urlparse(request_url)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}/v1/profile/update"
    return "/v1/profile/update"


def _normalize_skin_type(value: Any) -> Optional[str]:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    if any(k in raw for k in ["oily", "油"]):
        return "oily"
    if any(k in raw for k in ["dry", "干"]):
        return "dry"
    if any(k in raw for k in ["combination", "combo", "混"]):
        return "combination"
    if any(k in raw for k in ["sensitive", "敏感"]):
        return "sensitive"
    if any(k in raw for k in ["normal", "neutral", "中性"]):
        return "normal"
    return raw


def _normalize_sensitivity(value: Any, skin_type: Optional[str]) -> Optional[str]:
    raw = str(value or "").strip().lower()
    if raw:
        if any(k in raw for k in ["high", "高", "敏感"]):
            return "high"
        if any(k in raw for k in ["low", "低"]):
            return "low"
        if any(k in raw for k in ["medium", "中"]):
            return "medium"
        return raw
    if skin_type == "sensitive":
        return "high"
    return None


def _normalize_barrier_status(value: Any) -> Optional[str]:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    if any(k in raw for k in ["impaired", "damage", "受损", "不稳", "脆弱", "compromised"]):
        return "impaired"
    if any(k in raw for k in ["healthy", "stable", "健康", "稳定"]):
        return "healthy"
    return raw


def _normalize_budget_tier(value: Any) -> Optional[str]:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    if any(k in raw for k in ["low", "budget", "¥200", "$200"]):
        return "¥200"
    if any(k in raw for k in ["mid", "middle", "¥500", "$500"]):
        return "¥500"
    if any(k in raw for k in ["high", "premium", "¥1000", "$1000"]):
        return "¥1000+"
    if raw in {"unknown", "不确定", "unsure"}:
        return "不确定"
    return str(value)


def _normalize_goals(concerns: Any) -> List[str]:
    if not isinstance(concerns, list):
        return []
    goals: List[str] = []
    for item in concerns:
        s = str(item or "").strip().lower()
        if not s:
            continue
        if any(k in s for k in ["acne", "痘", "breakout", "闭口"]):
            goals.append("acne")
        elif any(k in s for k in ["red", "泛红", "sting", "刺痛"]):
            goals.append("redness")
        elif any(k in s for k in ["bright", "色沉", "斑", "痘印", "暗沉"]):
            goals.append("brightening")
        elif any(k in s for k in ["pore", "毛孔", "blackhead", "黑头"]):
            goals.append("pores")
        elif any(k in s for k in ["wrinkle", "anti", "细纹", "抗老"]):
            goals.append("antiaging")
        elif any(k in s for k in ["dry", "hydration", "干燥", "紧绷", "起皮"]):
            goals.append("hydration")
        else:
            goals.append(str(item))
    dedup: List[str] = []
    for g in goals:
        if g not in dedup:
            dedup.append(g)
    return dedup[:6]


def _profile_patch_from_case(case: Dict[str, Any], language: str) -> Dict[str, Any]:
    ctx = case.get("context")
    if not isinstance(ctx, dict):
        return {}
    skin = ctx.get("skin_profile") if isinstance(ctx.get("skin_profile"), dict) else {}
    prefs = ctx.get("preferences") if isinstance(ctx.get("preferences"), dict) else {}
    env = ctx.get("environment") if isinstance(ctx.get("environment"), dict) else {}

    skin_type = _normalize_skin_type(skin.get("skin_type") or skin.get("skinType"))
    sensitivity = _normalize_sensitivity(skin.get("sensitivity"), skin_type)
    barrier = _normalize_barrier_status(skin.get("status") or skin.get("barrier") or skin.get("barrier_status"))
    goals = _normalize_goals(skin.get("concerns") or skin.get("goals"))
    budget = _normalize_budget_tier(prefs.get("budget"))
    region = skin.get("region") or env.get("region") or ("CN" if language == "CN" else None)
    contra: List[str] = []
    if skin.get("pregnant_or_breastfeeding") is True:
        contra.append("pregnancy_or_breastfeeding")

    patch: Dict[str, Any] = {}
    if skin_type:
        patch["skinType"] = skin_type
    if sensitivity:
        patch["sensitivity"] = sensitivity
    if barrier:
        patch["barrierStatus"] = barrier
    if goals:
        patch["goals"] = goals
    if region:
        patch["region"] = str(region)
    if budget:
        patch["budgetTier"] = budget
    if contra:
        patch["contraindications"] = contra
    return patch


def _should_retry(status_code: int, err: Optional[Exception]) -> bool:
    if err is not None:
        return True
    return status_code in {429, 500, 502, 503, 504}


def _run_one(index: int, case: Dict[str, Any]) -> Dict[str, Any]:
    case_id = str(case.get("case_id") or f"case_{index}")
    payload = _build_payload(case)
    route = _entry_route(case)
    api_path = str(case.get("api_path") or "").strip()
    request_url = _resolve_url(api_url, api_path, route)
    language = _normalize_language(case.get("language") or locale)
    retries = 0
    started = time.perf_counter()
    resp_status = None
    resp_text = ""
    resp_json: Optional[Dict[str, Any]] = None
    final_error = ""
    bootstrap_info: Dict[str, Any] = {"enabled": profile_bootstrap, "attempted": False}

    if profile_bootstrap:
        patch = _profile_patch_from_case(case, language)
        if patch:
            bootstrap_info["attempted"] = True
            bootstrap_info["fields"] = sorted(patch.keys())
            bootstrap_url = _profile_update_url(request_url)
            bootstrap_info["url"] = bootstrap_url
            try:
                rb = requests.post(
                    bootstrap_url,
                    headers=_headers(case_id),
                    json=patch,
                    timeout=timeout_s,
                )
                bootstrap_info["http_status"] = int(rb.status_code)
                if 200 <= rb.status_code < 300:
                    bootstrap_info["ok"] = True
                else:
                    bootstrap_info["ok"] = False
                    bootstrap_info["error"] = f"http_{rb.status_code}"
            except Exception as e:
                bootstrap_info["ok"] = False
                bootstrap_info["error"] = f"{type(e).__name__}: {e}"

    for attempt in range(max_retries + 1):
        err: Optional[Exception] = None
        try:
            t0 = time.perf_counter()
            r = requests.post(
                request_url,
                headers=_headers(case_id),
                json=payload,
                timeout=timeout_s,
            )
            resp_status = int(r.status_code)
            resp_text = r.text
            latency_ms = (time.perf_counter() - t0) * 1000.0
            try:
                parsed = r.json()
                resp_json = parsed if isinstance(parsed, dict) else {"_raw": parsed}
            except Exception:
                resp_json = None
            if not _should_retry(resp_status, None):
                break
            final_error = f"http_{resp_status}"
        except Exception as e:
            latency_ms = (time.perf_counter() - t0) * 1000.0 if "t0" in locals() else None
            err = e
            final_error = f"{type(e).__name__}: {e}"
        if attempt < max_retries and _should_retry(resp_status or 0, err):
            retries += 1
            sleep_s = min(8.0, 0.8 * (2 ** attempt) + random.uniform(0.0, 0.3))
            time.sleep(sleep_s)
            continue
        break

    total_ms = (time.perf_counter() - started) * 1000.0
    assistant_text = _extract_assistant_text(resp_json or {})
    usage = _extract_usage(resp_json or {})
    card_types = _extract_card_types(resp_json or {})
    ok = bool(resp_status and 200 <= resp_status < 300)

    return {
        "index": index,
        "case_id": case_id,
        "tags": case.get("tags") or [],
        "entry_route": route,
        "api_path": api_path or None,
        "request_url": request_url,
        "expected_assertions": case.get("expected_assertions") or [],
        "request": {
            "message": payload.get("message"),
            "messages": payload.get("messages"),
            "language": payload.get("language"),
            "session": payload.get("session"),
            "action": payload.get("action"),
            "client_state": payload.get("client_state"),
            "anchor_product_id": payload.get("anchor_product_id"),
            "context": case.get("context"),
        },
        "profile_bootstrap": bootstrap_info,
        "started_at": _now_iso(),
        "latency_ms": round(total_ms, 2),
        "http_status": resp_status,
        "ok": ok,
        "retries": retries,
        "error": None if ok else final_error or "unknown_error",
        "token_usage": usage,
        "assistant_text": assistant_text,
        "card_types": card_types,
        "response_json": resp_json,
        "response_text": resp_text,
    }


cases: List[Dict[str, Any]] = []
for line in cases_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    if isinstance(obj, dict):
        cases.append(obj)

results: List[Dict[str, Any]] = []
with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
    futures = [pool.submit(_run_one, i, case) for i, case in enumerate(cases)]
    for fut in concurrent.futures.as_completed(futures):
        results.append(fut.result())

results.sort(key=lambda x: x["index"])
out_path.parent.mkdir(parents=True, exist_ok=True)
with out_path.open("w", encoding="utf-8") as f:
    for row in results:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")

ok_count = sum(1 for r in results if r.get("ok"))
print(out_path)
route_counts: Dict[str, int] = {}
for row in results:
    route = str(row.get("entry_route") or "unknown")
    route_counts[route] = route_counts.get(route, 0) + 1
print(
    json.dumps(
        {
            "total": len(results),
            "ok": ok_count,
            "fail": len(results) - ok_count,
            "avg_latency_ms": round(sum(float(r.get("latency_ms") or 0.0) for r in results) / max(len(results), 1), 2),
            "route_counts": route_counts,
        },
        ensure_ascii=False,
    )
)
PY

echo "Batch run complete."
echo "seed_cases=$seed_count min_seed_cases=$MIN_SEED_CASES generated_cases=$GENERATE_CASES generated_cases_file=$GENERATED_CASES merged_cases_file=$MERGED_CASES"
echo "results=$RESULTS_PATH"
