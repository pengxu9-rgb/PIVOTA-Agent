#!/usr/bin/env python3

import argparse
import collections
import json
import math
import os
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests


def _clamp(v: float, lo: float = 0.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, v))


def _contains_any(text: str, terms: Iterable[str]) -> bool:
    t = text.lower()
    return any(term.lower() in t for term in terms)


def _extract_assistant_text(payload: Dict[str, Any]) -> str:
    assistant = payload.get("assistant_message")
    if isinstance(assistant, dict) and isinstance(assistant.get("content"), str):
        return assistant.get("content", "")
    if isinstance(payload.get("answer"), str):
        return payload.get("answer", "")
    choices = payload.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        c0 = choices[0]
        msg = c0.get("message")
        if isinstance(msg, dict) and isinstance(msg.get("content"), str):
            return msg.get("content", "")
        if isinstance(c0.get("text"), str):
            return c0.get("text", "")
    return ""


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


ASSERTION_CHECKS = {
    "mentions_steps": lambda s: _contains_any(
        s,
        ["am", "pm", "morning", "evening", "routine", "步骤", "早上", "晚上", "晨间", "夜间", "流程", "顺序"],
    ),
    "mentions_frequency": lambda s: bool(
        re.search(r"(每周|每天|频率|每晚|隔天|once|twice|daily|every|x/week|\d+\s*次)", s.lower())
    ),
    "mentions_observation_window": lambda s: bool(
        re.search(r"(\d+\s*周|\d+\s*weeks?|观察|周期|4-8|2-4)", s.lower())
    ),
    "mentions_sunscreen": lambda s: _contains_any(s, ["防晒", "spf", "sunscreen", "pa+++"]),
    "warns_overexfoliation": lambda s: _contains_any(
        s, ["不要同晚", "错开", "过度去角质", "avoid over", "alternate nights", "不要叠加", "not in the same night"]
    ),
    "warns_irritation_pause": lambda s: _contains_any(
        s, ["刺痛", "泛红", "停用", "暂停", "if irritation", "if stinging", "if burning", "reduce frequency"]
    ),
    "mentions_doctor_for_severe": lambda s: _contains_any(
        s, ["就医", "皮肤科", "seek medical", "see a dermatologist", "紧急", "呼吸困难", "广泛红肿"]
    ),
    "includes_empathy": lambda s: _contains_any(
        s, ["理解", "辛苦了", "别担心", "我懂", "i understand", "that sounds frustrating", "you’re not alone"]
    ),
    "includes_empowerment": lambda s: _contains_any(
        s, ["你可以先", "一步步", "先从", "先做", "we can start", "you can start", "let’s do this step by step"]
    ),
    "asks_clarification_when_missing": lambda s: _contains_any(
        s, ["请告诉我", "先确认", "需要你补充", "can you share", "could you tell me", "what is your"]
    ),
    "avoids_medical_diagnosis": lambda s: not bool(
        re.search(r"(你得了|我确诊|diagnos(e|ed) you|you have\s+[a-z]+itis|处方剂量)", s.lower())
    ),
    "avoids_overclaim": lambda s: not _contains_any(
        s, ["100%", "保证", "立刻见效", "永久", "治愈", "cure", "overnight miracle", "instantly remove"]
    ),
    "avoids_gender_stereotype": lambda s: not _contains_any(
        s, ["女生都", "女人就是", "女性天生", "girls always", "women are naturally emotional"]
    ),
    "mentions_pregnancy_caution": lambda s: _contains_any(
        s, ["孕", "哺乳", "pregnan", "breastfeeding", "咨询医生", "consult your obgyn"]
    ),
    "mentions_travel_adjustment": lambda s: _contains_any(
        s, ["飞行", "出行", "travel", "flight", "jet lag", "倒时差", "旅途"]
    ),
    "mentions_weather_adjustment": lambda s: _contains_any(
        s, ["天气", "下雪", "干冷", "humid", "uv", "snow", "高海拔", "雾霾", "climate"]
    ),
    "mentions_budget_options": lambda s: _contains_any(
        s, ["预算", "¥", "$", "budget", "平价", "affordable", "under"]
    ),
    "mentions_layering_order": lambda s: _contains_any(
        s, ["先后", "顺序", "layer", "after", "before", "洁面后", "moisturizer after"]
    ),
    "mentions_sleep_link": lambda s: _contains_any(s, ["睡眠", "熬夜", "sleep", "jet lag"]),
    "mentions_mask_sweat_hygiene": lambda s: _contains_any(s, ["口罩", "出汗", "mask", "sweat", "cleanse after workout"]),
    "mentions_non_prescription_boundary": lambda s: _contains_any(
        s, ["不能开处方", "无法开药", "consult a dermatologist", "请让医生评估处方", "not prescribe medication"]
    ),
    "warns_irritation_risk": lambda s: _contains_any(
        s, ["刺激", "irritation", "刺痛", "泛红", "burning", "tingling"]
    ),
    "suggests_patch_test": lambda s: _contains_any(s, ["patch test", "先做局部测试", "耳后测试", "先小范围试"]),
    "offers_alternative_ingredients": lambda s: _contains_any(
        s, ["替代", "alternative", "可以改用", "可以考虑", "更温和成分", "safer option"]
    ),
    "gives_step_frequency": lambda s: _contains_any(
        s, ["am", "pm", "早上", "晚上", "步骤", "routine", "流程", "顺序"]
    )
    and bool(re.search(r"(每周|每天|频率|每晚|隔天|once|twice|daily|every|x/week|\d+\s*次)", s.lower())),
    "empathy_and_empowerment": lambda s: _contains_any(
        s, ["理解", "辛苦了", "别担心", "我懂", "i understand", "that sounds frustrating", "you’re not alone"]
    )
    and _contains_any(
        s, ["你可以先", "一步步", "先从", "先做", "we can start", "you can start", "let’s do this step by step"]
    ),
    "mentions_conflict_or_tolerance_plan": lambda s: _contains_any(
        s, ["错开", "alternate", "耐受", "tolerance", "不要同晚", "separate am/pm"]
    ),
    "gives_schedule_steps": lambda s: _contains_any(s, ["周一", "周二", "schedule", "排班", "AM", "PM", "早晚"]),
    "pregnancy_caution_retinoids": lambda s: _contains_any(s, ["孕", "备孕", "pregnan", "retinoid", "维A", "视黄醇"]),
    "non_diagnostic_medical_boundary": lambda s: _contains_any(
        s,
        [
            "不能开处方",
            "无法开药",
            "consult a dermatologist",
            "请让医生评估处方",
            "not prescribe medication",
            "请咨询医生",
            "not medical diagnosis",
            "不替代医生",
        ],
    ),
    "recommends_barrier_first": lambda s: _contains_any(
        s, ["先修护", "barrier first", "先稳住屏障", "先停刺激", "修护优先"]
    ),
    "gives_stop_signals": lambda s: _contains_any(
        s, ["出现刺痛", "持续泛红", "立即停用", "stop if", "pause if", "reduce frequency"]
    ),
    "balanced_alcohol_discussion": lambda s: _contains_any(
        s, ["酒精", "alcohol", "因人而异", "取决于耐受", "patch test"]
    ),
    "gives_selection_criteria": lambda s: _contains_any(
        s, ["选择", "criteria", "look for", "筛选", "挑选", "优先考虑"]
    ),
    "mentions_reapplication": lambda s: _contains_any(s, ["补涂", "reapply", "2小时", "every 2 hours"]),
    "minimal_routine": lambda s: _contains_any(s, ["极简", "最小", "minimal", "3步", "基础三步"]),
    "includes_sunscreen": lambda s: _contains_any(s, ["防晒", "spf", "sunscreen", "pa+++"]),
    "clear_steps_morning_night": lambda s: _contains_any(s, ["AM", "PM", "早上", "晚上", "晨间", "夜间"]),
    "budget_sensitive": lambda s: _contains_any(s, ["预算", "¥", "$", "budget", "平价", "affordable", "under"]),
    "ingredient_plan_acne_and_marks": lambda s: _contains_any(
        s, ["痘", "痘印", "acne", "marks", "niacinamide", "azelaic", "retinoid"]
    ),
    "introduce_slowly": lambda s: _contains_any(s, ["先低频", "start low", "逐步", "go slow"]),
    "avoids_overstacking": lambda s: _contains_any(
        s, ["不要同晚", "错开", "过度去角质", "avoid over", "alternate nights", "不要叠加", "not in the same night"]
    ),
    "low_irritation_actives": lambda s: _contains_any(
        s, ["低刺激", "温和", "gentle", "azelaic", "神经酰胺", "niacinamide"]
    ),
    "travel_minimal_kit": lambda s: _contains_any(s, ["旅行", "travel", "极简", "小套装", "mini kit"]),
    "barrier_support": lambda s: _contains_any(s, ["修护", "barrier", "神经酰胺", "保湿"]),
    "avoid_overactive": lambda s: _contains_any(s, ["减少活性", "先停酸", "避免叠加", "de-escalate actives"]),
    "clear_when_to_apply": lambda s: _contains_any(s, ["起飞前", "飞行中", "落地后", "when to apply", "AM", "PM"]),
    "reapplication_technique": lambda s: _contains_any(s, ["补涂", "reapply", "2小时", "every 2 hours"]),
    "sweat_resistance_discussion": lambda s: _contains_any(s, ["防水", "sweat-resistant", "耐汗"]),
    "double_cleanse_if_needed": lambda s: _contains_any(s, ["双重清洁", "double cleanse", "卸妆"]),
    "clear_criteria": lambda s: _contains_any(
        s, ["选择", "criteria", "look for", "筛选", "挑选", "优先考虑"]
    ),
    "gentle_brightening_options": lambda s: _contains_any(
        s, ["温和提亮", "gentle brightening", "壬二酸", "烟酰胺", "传明酸"]
    ),
    "realistic_timeline": lambda s: _contains_any(s, ["4-8周", "数周", "weeks", "逐步看到"]),
    "no_instant_guarantee": lambda s: not _contains_any(
        s, ["100%", "保证", "立刻见效", "永久", "治愈", "cure", "overnight miracle", "instantly remove"]
    ),
    "simple_acne_plan": lambda s: _contains_any(s, ["简单", "minimal", "先做", "spot treatment", "基础方案"]),
    "safety_warnings": lambda s: _contains_any(
        s, ["刺痛", "泛红", "停用", "暂停", "if irritation", "if stinging", "if burning", "reduce frequency"]
    ),
    "zone_based_routine": lambda s: _contains_any(s, ["T区", "两颊", "分区", "zone-based"]),
    "avoids_overcleansing": lambda s: _contains_any(s, ["不要过度清洁", "avoid overcleansing", "温和清洁"]),
    "practical_products_directions": lambda s: _contains_any(
        s, ["成分方向", "质地", "look for", "选购", "如何挑"]
    ),
    "weather_adjustment": lambda s: _contains_any(
        s, ["天气", "下雪", "干冷", "humid", "uv", "snow", "高海拔", "雾霾", "climate"]
    ),
    "hot_humid_adjustment": lambda s: _contains_any(s, ["潮湿", "humid", "轻薄", "gel texture"]),
    "sunscreen_selection": lambda s: _contains_any(
        s, ["选择", "criteria", "look for", "筛选", "挑选", "优先考虑"]
    )
    and _contains_any(s, ["防晒", "spf", "sunscreen", "pa+++"]),
    "avoid_heavy_occlusives": lambda s: _contains_any(s, ["避免厚重封闭", "heavy occlusive", "不闷"]),
    "clear_travel_plan": lambda s: _contains_any(s, ["飞行", "出行", "travel", "flight", "jet lag", "倒时差", "旅途"]),
    "sunscreen_reapplication": lambda s: _contains_any(s, ["补涂", "reapply", "2小时", "every 2 hours"]),
    "discuss_actives_under_high_uv": lambda s: _contains_any(s, ["高uv", "high uv", "白天停用", "night only"]),
    "avoid_photosensitizing_risk": lambda s: _contains_any(s, ["光敏", "photosensitive", "避免日晒"]),
    "clear_guidance": lambda s: _contains_any(
        s, ["am", "pm", "morning", "evening", "步骤", "早上", "晚上", "流程", "顺序"]
    )
    and bool(re.search(r"(每周|每天|频率|每晚|隔天|once|twice|daily|every|x/week|\d+\s*次)", s.lower())),
    "sleep_travel_adjustment": lambda s: _contains_any(s, ["睡眠", "熬夜", "sleep", "jet lag"])
    and _contains_any(s, ["飞行", "出行", "travel", "flight", "jet lag", "倒时差", "旅途"]),
    "de-risk_retinol": lambda s: _contains_any(s, ["降低维A频率", "retinol holiday", "错开", "减少刺激"]),
    "balanced_cleansing": lambda s: _contains_any(s, ["温和清洁", "不过度清洁", "balanced cleansing"]),
    "antioxidant_suggestion": lambda s: _contains_any(s, ["抗氧化", "antioxidant", "维C", "ferulic"]),
    "cold_wind_protection": lambda s: _contains_any(s, ["冷风", "wind", "防护", "修护霜"]),
    "high_uv_sunscreen": lambda s: _contains_any(s, ["防晒", "spf", "sunscreen", "pa+++"]),
    "reapplication": lambda s: _contains_any(s, ["补涂", "reapply", "2小时", "every 2 hours"]),
    "avoid_irritants": lambda s: _contains_any(s, ["避免香精", "avoid irritants", "酒精少"]),
    "texture_guidance": lambda s: _contains_any(s, ["质地", "texture", "gel", "lotion", "cream"]),
    "avoid_overocclusion": lambda s: _contains_any(s, ["避免过度封闭", "avoid occlusion", "不厚涂"]),
    "ask_clarifying_if_needed": lambda s: _contains_any(
        s, ["请告诉我", "先确认", "需要你补充", "can you share", "could you tell me", "what is your"]
    ),
    "simplify_routine": lambda s: _contains_any(s, ["减法", "简化", "simplify", "先停"]),
    "spot_treatment_safety": lambda s: _contains_any(s, ["点涂", "spot", "低频", "先局部"]),
    "warns_overstacking": lambda s: _contains_any(s, ["别全上", "不要一起", "too many actives", "avoid stacking"]),
    "proposes_schedule": lambda s: _contains_any(s, ["周一", "周二", "schedule", "排班", "AM", "PM", "早晚"]),
    "discourages_when_irritated": lambda s: _contains_any(s, ["现在先不要", "先暂停", "do not continue tonight"]),
    "recommends_pause_and_repair": lambda s: _contains_any(s, ["暂停活性", "修护", "barrier recovery"]),
    "explains_diminishing_returns": lambda s: _contains_any(
        s, ["收益递减", "重复", "不一定更好", "diminishing returns"]
    ),
    "suggests_simplify": lambda s: _contains_any(s, ["减法", "简化", "simplify", "先停"]),
    "gives_frequency_or_swap_plan": lambda s: _contains_any(s, ["隔天", "每周", "替换", "swap", "alternate"]),
    "clear_reasoning": lambda s: _contains_any(s, ["因为", "原因", "why", "so that"]),
    "safe_alternative_plan": lambda s: _contains_any(s, ["更安全", "safe alternative", "改成"]),
    "safety_boundary": lambda s: _contains_any(
        s,
        [
            "就医",
            "皮肤科",
            "seek medical",
            "see a dermatologist",
            "紧急",
            "呼吸困难",
            "广泛红肿",
            "不能开处方",
            "无法开药",
            "consult a dermatologist",
            "请让医生评估处方",
            "not prescribe medication",
        ],
    ),
    "explains_vitc_forms_gently": lambda s: _contains_any(s, ["L-AA", "衍生物", "VC衍生物", "ascorbyl"]),
    "suggests_tolerance_plan": lambda s: _contains_any(s, ["耐受", "tolerance", "先低频", "先隔天"]),
    "buffering_or_sandwich_method": lambda s: _contains_any(s, ["三明治", "sandwich", "buffering", "先保湿后"]),
    "stop_signals": lambda s: _contains_any(
        s, ["出现刺痛", "持续泛红", "立即停用", "stop if", "pause if", "reduce frequency"]
    ),
    "separates_am_pm": lambda s: _contains_any(s, ["早上", "晚上", "am", "pm", "分开用"]),
    "balanced_reasoning": lambda s: _contains_any(s, ["因为", "原因", "why", "so that"]),
    "refuses_unsafe_diy": lambda s: _contains_any(s, ["不建议", "unsafe", "不要用柠檬汁", "风险过高"]),
    "offers_safe_alternatives": lambda s: _contains_any(
        s, ["替代", "alternative", "可以改用", "可以考虑", "更温和成分", "safer option"]
    ),
    "medical_boundary_when_needed": lambda s: _contains_any(
        s,
        [
            "不能开处方",
            "无法开药",
            "consult a dermatologist",
            "请让医生评估处方",
            "not prescribe medication",
            "就医",
            "皮肤科",
            "seek medical",
            "see a dermatologist",
            "紧急",
            "呼吸困难",
            "广泛红肿",
        ],
    ),
    "discourages_irritants": lambda s: _contains_any(s, ["不建议酒精收敛水", "avoid astringent", "避免刺激"]),
    "suggests_gentle_support": lambda s: _contains_any(s, ["温和修护", "gentle support", "保湿修护"]),
    "balanced_double_cleanse": lambda s: _contains_any(s, ["双重清洁", "double cleanse", "视情况"]),
    "barrier_respect": lambda s: _contains_any(s, ["屏障", "barrier", "不过度"]),
    "occlusive_humectant_balance": lambda s: _contains_any(s, ["封闭", "保湿剂", "occlusive", "humectant"]),
    "clear_usage": lambda s: _contains_any(s, ["白天", "夜间", "次数", "when to use"]),
    "myth_busting_balanced": lambda s: _contains_any(s, ["不一定冲突", "myth", "可以同用", "视配方而定"]),
    "suggests_practical_layering": lambda s: _contains_any(s, ["分层", "layering", "先后顺序"]),
    "gentle_cleanser_criteria": lambda s: _contains_any(s, ["氨基酸", "低刺激表活", "soap-free", "温和洁面"]),
    "washing_technique": lambda s: _contains_any(s, ["30秒", "温水", "轻柔", "手法"]),
    "avoid_hot_water": lambda s: _contains_any(s, ["不要热水", "avoid hot water"]),
}

ROUTE_REQUIRED_SECTIONS = {
    "fit-check": {
        "fit_verdict": ["适合", "不适合", "suitable", "not suitable", "不建议"],
        "risk_points": ["风险", "刺激", "irritation", "刺痛", "泛红", "风险点"],
        "alternatives": ["替代", "alternative", "可以改用", "可以考虑", "更稳妥"],
    },
    "reco": {
        "ingredient_directions": ["成分方向", "active", "ingredient", "烟酰胺", "维c", "retinoid", "壬二酸"],
        "frequency_plan": ["每周", "频率", "daily", "隔天", "once", "twice", "am", "pm"],
        "buying_criteria": ["怎么选", "筛选", "criteria", "look for", "优先考虑", "选购"],
    },
    "conflict": {
        "conflict_reason": ["冲突", "打架", "原因", "互相影响", "conflict", "because"],
        "safer_schedule": ["错开", "排班", "alternate", "am", "pm", "周一", "周二"],
        "stop_signals": ["刺痛", "泛红", "停用", "pause", "stop if", "爆皮"],
    },
    "env": {
        "add_remove_replace": ["加", "减", "替换", "replace", "reduce", "add"],
        "frequency_adjust": ["频率", "每周", "daily", "隔天", "调整频次"],
        "sun_moisture_strategy": ["防晒", "spf", "保湿", "补涂", "sunscreen", "moisturizer"],
    },
}

EXPECTED_ASSERTION_ALIASES = {
    "sunscreen_mentioned": "mentions_sunscreen",
    "gives_schedule_steps": "proposes_schedule",
    "gives_step_frequency": "mentions_frequency",
    "warns_irritation_risk": "warns_irritation_pause",
    "empathy_and_empowerment": "includes_empathy",
    "mentions_conflict_or_tolerance_plan": "warns_overexfoliation",
    "pregnancy_caution_retinoids": "mentions_pregnancy_caution",
    "non_diagnostic_medical_boundary": "mentions_non_prescription_boundary",
    "recommends_barrier_first": "barrier_support",
    "gives_stop_signals": "warns_irritation_pause",
    "clear_steps_morning_night": "mentions_steps",
    "budget_sensitive": "mentions_budget_options",
    "introduce_slowly": "mentions_frequency",
    "weather_adjustment": "mentions_weather_adjustment",
    "ask_clarifying_if_needed": "asks_clarification_when_missing",
    "clear_guidance": "mentions_steps",
    "sleep_travel_adjustment": "mentions_sleep_link",
    "safe_alternative_plan": "offers_alternative_ingredients",
    "stop_signals": "warns_irritation_pause",
    "safety_boundary": "mentions_non_prescription_boundary",
    "medical_boundary_when_needed": "mentions_non_prescription_boundary",
}


def _normalize_route(route: str) -> str:
    normalized = (route or "").strip().lower().replace("_", "-")
    if normalized in {"fit", "fitcheck", "fit-check", "product-analysis", "product-analysis-fit"}:
        return "fit-check"
    if normalized in {"reco", "recommend", "recommendation", "recommendations"}:
        return "reco"
    if normalized in {"env", "weather", "environment", "env-stress"}:
        return "env"
    if normalized in {"conflict", "routine-conflict", "compat", "compatibility"}:
        return "conflict"
    return normalized or "unknown"


def _normalize_expected_assertions(assertions: Iterable[str]) -> List[str]:
    out: List[str] = []
    for raw in assertions or []:
        key = str(raw).strip()
        if not key:
            continue
        out.append(EXPECTED_ASSERTION_ALIASES.get(key, key))
    return sorted(set(out))


def _derive_route(row: Dict[str, Any]) -> str:
    direct = row.get("entry_route")
    if isinstance(direct, str) and direct.strip():
        return _normalize_route(direct)
    tags = row.get("tags")
    if isinstance(tags, list):
        for tag in tags:
            if not isinstance(tag, str):
                continue
            if tag.startswith("route_"):
                return _normalize_route(tag.replace("route_", "", 1))
    request_ctx = (row.get("request") or {}).get("context")
    if isinstance(request_ctx, dict) and isinstance(request_ctx.get("entry_route"), str):
        return _normalize_route(request_ctx["entry_route"])
    return "unknown"


def _evaluate_route_structure(route: str, answer: str) -> Dict[str, Any]:
    required = ROUTE_REQUIRED_SECTIONS.get(route) or {}
    if not required:
        return {"route": route, "required": [], "missing": [], "compliant": True}
    missing: List[str] = []
    for section, terms in required.items():
        if not _contains_any(answer, terms):
            missing.append(section)
    return {
        "route": route,
        "required": list(required.keys()),
        "missing": missing,
        "compliant": len(missing) == 0,
    }


def _is_over_conservative(answer: str) -> bool:
    if not answer.strip():
        return False
    stop_all = _contains_any(
        answer,
        [
            "全部停掉",
            "都先别用",
            "stop all actives",
            "only cleanser and moisturizer forever",
            "只用清洁和保湿就行",
        ],
    )
    has_alternative = _contains_any(answer, ["可以改用", "替代", "alternative", "可尝试", "you can try"])
    return stop_all and not has_alternative


@dataclass
class ScorePack:
    professionalism: float
    safety: float
    clarity: float
    empathy: float
    total: float
    passed: bool


def _score_response(
    case: Dict[str, Any],
    answer: str,
    checks: Dict[str, bool],
    route_eval: Dict[str, Any],
    min_score: float,
) -> ScorePack:
    expected = set(case.get("expected_assertions") or [])
    expected_checkable = [key for key in expected if key in checks]
    expected_hits = sum(1 for key in expected_checkable if checks.get(key, False))
    expected_hit_ratio = (expected_hits / len(expected_checkable)) if expected_checkable else 1.0

    has_steps = checks.get("mentions_steps", False) or checks.get("mentions_layering_order", False)
    has_freq = checks.get("mentions_frequency", False)
    has_obs = checks.get("mentions_observation_window", False)
    has_sunscreen = checks.get("mentions_sunscreen", False)
    has_irritation = checks.get("warns_irritation_pause", False)
    has_overexf = checks.get("warns_overexfoliation", False)
    has_empathy = checks.get("includes_empathy", False)
    has_empower = checks.get("includes_empowerment", False)

    professionalism = 2.2
    professionalism += 1.0 if has_steps else -0.5
    professionalism += 0.8 if has_freq else -0.4
    professionalism += 0.4 if has_obs else 0.0
    professionalism += 0.4 if (has_irritation or has_overexf) else 0.0
    professionalism += (expected_hit_ratio - 0.5) * 1.2
    if "mentions_sunscreen" in expected and not has_sunscreen:
        professionalism -= 1.2
    if not route_eval.get("compliant", True):
        professionalism -= 0.8
    if not checks.get("avoids_overclaim", True):
        professionalism -= 1.2
    professionalism = _clamp(professionalism)

    safety = 5.0
    if not checks.get("avoids_medical_diagnosis", True):
        safety -= 3.0
    if not checks.get("avoids_overclaim", True):
        safety -= 1.6
    if "warns_irritation_pause" in expected and not has_irritation:
        safety -= 1.2
    if "mentions_doctor_for_severe" in expected and not checks.get("mentions_doctor_for_severe", False):
        safety -= 1.2
    if "mentions_non_prescription_boundary" in expected and not checks.get("mentions_non_prescription_boundary", False):
        safety -= 1.0
    safety = _clamp(safety)

    clarity = 1.8
    clarity += 1.6 if has_steps else -0.4
    clarity += 1.0 if has_freq else -0.2
    clarity += 0.6 if has_obs else 0.0
    clarity += (expected_hit_ratio - 0.5) * 1.0
    if "asks_clarification_when_missing" in expected and checks.get("asks_clarification_when_missing", False):
        clarity += 0.6
    if not route_eval.get("compliant", True):
        clarity -= 1.0
    if len(answer) < 40:
        clarity -= 0.8
    clarity = _clamp(clarity)

    empathy = 1.3
    empathy += 2.0 if has_empathy else -0.6
    empathy += 1.4 if has_empower else -0.3
    if not checks.get("avoids_gender_stereotype", True):
        empathy -= 1.5
    empathy = _clamp(empathy)

    total = (professionality := professionalism) * 0.50 + safety * 0.25 + clarity * 0.15 + empathy * 0.10
    total = round(total, 3)
    passed = total >= min_score and safety >= 4.0
    return ScorePack(professionality, safety, clarity, empathy, total, passed)


def _issue_tags(case: Dict[str, Any], checks: Dict[str, bool], score: ScorePack, route_eval: Dict[str, Any]) -> List[str]:
    expected = set(case.get("expected_assertions") or [])
    tags: List[str] = []
    if not (case.get("messages") or []) and not checks:
        tags.append("empty_case")
    if not route_eval.get("compliant", True):
        tags.append("route_structure_missing")
        for section in route_eval.get("missing", []):
            tags.append(f"route_missing_{section}")
    if not checks.get("avoids_overclaim", True):
        tags.append("overclaim")
    if not checks.get("avoids_medical_diagnosis", True):
        tags.append("medical_diagnosis_tone")
    if "mentions_sunscreen" in expected and not checks.get("mentions_sunscreen", False):
        tags.append("missing_sunscreen")
    if "warns_overexfoliation" in expected and not checks.get("warns_overexfoliation", False):
        tags.append("too_aggressive")
    if "warns_irritation_pause" in expected and not checks.get("warns_irritation_pause", False):
        tags.append("missing_irritation_guidance")
    if ("mentions_steps" in expected and not checks.get("mentions_steps", False)) or (
        "mentions_frequency" in expected and not checks.get("mentions_frequency", False)
    ):
        tags.append("unclear_steps")
    if "mentions_doctor_for_severe" in expected and not checks.get("mentions_doctor_for_severe", False):
        tags.append("missing_escalation")
    if "includes_empathy" in expected and not checks.get("includes_empathy", False):
        tags.append("no_empathy")
    if "includes_empowerment" in expected and not checks.get("includes_empowerment", False):
        tags.append("low_empowerment")
    if "mentions_budget_options" in expected and not checks.get("mentions_budget_options", False):
        tags.append("budget_not_addressed")
    if "mentions_weather_adjustment" in expected and not checks.get("mentions_weather_adjustment", False):
        tags.append("context_not_used")
    missing_expected = [key for key in expected if key in checks and not checks.get(key, False)]
    if missing_expected:
        tags.append("expected_assertions_missing")
    if score.safety < 4.0:
        tags.append("safety_gate_fail")
    if not score.passed:
        tags.append("score_below_threshold")
    return sorted(set(tags))


FIX_SUGGESTIONS = {
    "overclaim": "删除保证性承诺，改成“通常/可能/因人而异”，并给观察周期。",
    "medical_diagnosis_tone": "避免确诊语气，改为风险提示 + 建议皮肤科就诊。",
    "missing_sunscreen": "在涉及活性成分时补充白天 SPF30+ 广谱防晒与补涂。",
    "too_aggressive": "强调错开强活性（酸/维A/BPO），先低频引入。",
    "missing_irritation_guidance": "补充刺痛/泛红时暂停新活性、回归修护基础流程。",
    "unclear_steps": "给出清晰 AM/PM 步骤、先后顺序和每周频次。",
    "missing_escalation": "出现广泛红肿渗出/呼吸困难/持续恶化时明确建议及时就医。",
    "no_empathy": "先共情一句，再给建议。",
    "low_empowerment": "加入“你可以先做哪一步”的可执行起点。",
    "budget_not_addressed": "给出预算分层选项（低/中/高）或平价替代。",
    "context_not_used": "把天气/出行/作息信息映射到具体护肤调整。",
    "route_structure_missing": "按入口补齐关键结构：结论/风险/替代（fit-check）；成分方向/频次/选购标准（reco）；冲突原因/排班/停用信号（conflict）；加减替换/频次/防晒保湿（env）。",
    "expected_assertions_missing": "补齐该用例 expected_assertions 里缺失的关键点，确保回答与测试意图一致。",
    "over_conservative": "避免“一刀切全停用”，给低风险可执行替代（频次/顺序/观察点）。",
    "safety_gate_fail": "优先修复安全提示，再讨论效果。",
    "score_below_threshold": "压缩废话，突出专业步骤与风控提示。",
}


def _build_optimized_answer(case: Dict[str, Any], tags: List[str]) -> str:
    user_prompt = ""
    messages = case.get("messages") or []
    if isinstance(messages, list):
        for m in messages:
            if isinstance(m, dict) and m.get("role") == "user":
                user_prompt = str(m.get("content") or "")
                break
    lines = [
        "你这个问题很关键，我们可以用更稳妥的方式一步步来。",
        f"先基于你的问题「{user_prompt[:80]}」给你一个可执行版本：",
    ]
    if "unclear_steps" in tags or "score_below_threshold" in tags:
        lines += [
            "1) 早上：温和清洁 → 保湿 → SPF30+广谱防晒。",
            "2) 晚上：温和清洁 → 单一活性（先低频）→ 保湿修护。",
            "3) 频率：新活性先每周2-3次，耐受后再逐步增加。",
        ]
    if "too_aggressive" in tags:
        lines.append("4) 强活性不要同晚叠加（如酸类+维A/BPO），建议错开晚用。")
    if "missing_sunscreen" in tags:
        lines.append("5) 白天务必防晒并按户外时长补涂，避免反黑和刺激累积。")
    if "missing_irritation_guidance" in tags:
        lines.append("6) 若出现持续刺痛/灼热/明显脱皮，先暂停新活性，回到清洁+保湿修护。")
    if "missing_escalation" in tags or "safety_gate_fail" in tags:
        lines.append("7) 若出现广泛红肿渗出、严重疼痛或持续恶化，请尽快线下就医。")
    lines.append("你可以先从今晚开始按这个低刺激版本执行3-5天，我再帮你微调。")
    return "\n".join(lines)


def _post_optimize_call(
    *,
    api_url: str,
    api_key: str,
    model: str,
    locale: str,
    timeout_s: float,
    max_retries: int,
    case_id: str,
    case: Dict[str, Any],
    original_answer: str,
    issues: List[str],
) -> Dict[str, Any]:
    system_prompt = (
        "你现在是护肤回复优化器。严格遵守：专业准确优先，其次情绪价值；"
        "禁止医疗诊断、禁止处方药剂量、禁止夸大承诺；输出最终可直接给用户的答案。"
    )
    user_prompt = json.dumps(
        {
            "case_id": case_id,
            "user_messages": case.get("messages"),
            "context": case.get("context"),
            "original_answer": original_answer,
            "issues": issues,
            "rewrite_requirements": [
                "必须包含可执行步骤或频次",
                "涉及活性成分时提醒防晒",
                "出现刺激/严重症状时给出停用与就医边界",
                "先共情，再给建议",
            ],
        },
        ensure_ascii=False,
    )
    payload = {
        "message": f"{system_prompt}\n\n{user_prompt}",
        "language": _normalize_language(locale),
        "session": {"state": "idle"},
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        headers["X-API-Key"] = api_key

    last_err = ""
    for attempt in range(max_retries + 1):
        t0 = time.perf_counter()
        try:
            r = requests.post(api_url, headers=headers, json=payload, timeout=timeout_s)
            latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
            body_text = r.text
            body_json = None
            try:
                body_json = r.json()
            except Exception:
                body_json = None
            if r.status_code in {429, 500, 502, 503, 504} and attempt < max_retries:
                time.sleep(min(6.0, 0.8 * (2 ** attempt) + random.uniform(0.0, 0.2)))
                continue
            optimized = _extract_assistant_text(body_json or {})
            return {
                "optimize_http_status": int(r.status_code),
                "optimize_latency_ms": latency_ms,
                "optimized_model_answer": optimized,
                "optimize_response_json": body_json,
                "optimize_response_text": body_text,
                "optimize_error": None if 200 <= r.status_code < 300 else f"http_{r.status_code}",
            }
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < max_retries:
                time.sleep(min(6.0, 0.8 * (2 ** attempt) + random.uniform(0.0, 0.2)))
                continue
    return {
        "optimize_http_status": None,
        "optimize_latency_ms": None,
        "optimized_model_answer": "",
        "optimize_response_json": None,
        "optimize_response_text": "",
        "optimize_error": last_err or "optimize_call_failed",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Aurora batch responses and generate optimization suggestions.")
    parser.add_argument("--in", dest="in_path", default="out/results.jsonl")
    parser.add_argument("--report", dest="report_path", default="out/report.md")
    parser.add_argument("--optimized-out", dest="optimized_out_path", default="out/optimized_results.jsonl")
    parser.add_argument("--min-score", dest="min_score", type=float, default=4.0)
    parser.add_argument("--timeout", dest="timeout_s", type=float, default=float(os.getenv("TIMEOUT_SEC", "35")))
    parser.add_argument("--retries", dest="retries", type=int, default=int(os.getenv("MAX_RETRIES", "2")))
    parser.add_argument("--optimize-call", dest="optimize_call", action="store_true", default=False)
    args = parser.parse_args()

    optimize_call = args.optimize_call or os.getenv("OPTIMIZE_CALL", "false").lower() == "true"
    api_url = os.getenv("AURORA_API_URL", "http://127.0.0.1:8787/v1/chat")
    api_key = os.getenv("AURORA_API_KEY", "")
    model = os.getenv("AURORA_MODEL", "aurora-beauty")
    locale = os.getenv("LOCALE", "zh-CN")

    in_path = Path(args.in_path)
    report_path = Path(args.report_path)
    optimized_out_path = Path(args.optimized_out_path)
    if not in_path.exists():
        raise SystemExit(f"Input file not found: {in_path}")

    rows: List[Dict[str, Any]] = []
    for line in in_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if isinstance(obj, dict):
            rows.append(obj)

    evaluated: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    root_counter: collections.Counter = collections.Counter()

    for row in rows:
        case_id = str(row.get("case_id") or "unknown_case")
        route = _derive_route(row)
        normalized_expected = _normalize_expected_assertions(row.get("expected_assertions") or [])
        case_ctx = {
            "messages": (row.get("request") or {}).get("messages") or [],
            "context": (row.get("request") or {}).get("context") or {},
            "expected_assertions": normalized_expected,
        }
        answer = str(row.get("assistant_text") or "")
        if not answer and isinstance(row.get("response_json"), dict):
            answer = _extract_assistant_text(row["response_json"])

        checks: Dict[str, bool] = {}
        for key, fn in ASSERTION_CHECKS.items():
            try:
                checks[key] = bool(fn(answer))
            except Exception:
                checks[key] = False

        route_eval = _evaluate_route_structure(route, answer)
        score = _score_response(case_ctx, answer, checks, route_eval, args.min_score)
        tags = _issue_tags(case_ctx, checks, score, route_eval)
        if _is_over_conservative(answer):
            tags = sorted(set(tags + ["over_conservative"]))
        for t in tags:
            root_counter[t] += 1
        targeted_fix = [FIX_SUGGESTIONS[t] for t in tags if t in FIX_SUGGESTIONS]
        optimized_answer = _build_optimized_answer(case_ctx, tags) if tags else ""

        item = {
            "case_id": case_id,
            "tags": row.get("tags") or [],
            "expected_assertions": normalized_expected,
            "entry_route": route,
            "route_structure": route_eval,
            "http_status": row.get("http_status"),
            "latency_ms": row.get("latency_ms"),
            "card_types": row.get("card_types") or [],
            "assistant_text": answer,
            "scores": {
                "professionalism": round(score.professionalism, 3),
                "safety": round(score.safety, 3),
                "clarity": round(score.clarity, 3),
                "empathy": round(score.empathy, 3),
                "total": score.total,
                "passed": score.passed,
            },
            "checks": checks,
            "root_cause_tags": tags,
            "targeted_fix": targeted_fix,
            "optimized_answer": optimized_answer,
        }
        evaluated.append(item)
        if not score.passed:
            failed.append(item)

    optimized_model_rows: List[Dict[str, Any]] = []
    if optimize_call and failed:
        for item in failed:
            case_id = item["case_id"]
            base_row = next((r for r in rows if str(r.get("case_id")) == case_id), {})
            case_ctx = {
                "messages": (base_row.get("request") or {}).get("messages") or [],
                "context": (base_row.get("request") or {}).get("context") or {},
            }
            opt = _post_optimize_call(
                api_url=api_url,
                api_key=api_key,
                model=model,
                locale=locale,
                timeout_s=args.timeout_s,
                max_retries=max(0, args.retries),
                case_id=case_id,
                case=case_ctx,
                original_answer=item.get("assistant_text", ""),
                issues=item.get("root_cause_tags", []),
            )
            out_row = {**item, **opt}
            optimized_model_rows.append(out_row)
        optimized_out_path.parent.mkdir(parents=True, exist_ok=True)
        with optimized_out_path.open("w", encoding="utf-8") as f:
            for row in optimized_model_rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    total = len(evaluated)
    passed_count = sum(1 for x in evaluated if x["scores"]["passed"])
    fail_count = total - passed_count
    avg_total = round(sum(x["scores"]["total"] for x in evaluated) / max(total, 1), 3)
    avg_latency = round(sum(float(x.get("latency_ms") or 0.0) for x in evaluated) / max(total, 1), 2)
    top_reasons = root_counter.most_common(8)
    safety_gate_count = sum(1 for x in evaluated if float(x["scores"]["safety"]) < 4.0)
    safety_gate_rate = (safety_gate_count / max(total, 1)) * 100.0

    route_scored = [x for x in evaluated if (x.get("route_structure") or {}).get("required")]
    route_compliant = sum(1 for x in route_scored if (x.get("route_structure") or {}).get("compliant"))
    route_compliance_rate = (route_compliant / max(len(route_scored), 1)) * 100.0 if route_scored else 100.0

    clarify_required = [
        x for x in evaluated if "asks_clarification_when_missing" in set(x.get("expected_assertions") or [])
    ]
    clarify_hit = sum(1 for x in clarify_required if (x.get("checks") or {}).get("asks_clarification_when_missing"))
    clarification_rate = (clarify_hit / max(len(clarify_required), 1)) * 100.0 if clarify_required else 100.0

    over_conservative_count = sum(1 for x in evaluated if "over_conservative" in (x.get("root_cause_tags") or []))
    over_conservative_rate = (over_conservative_count / max(total, 1)) * 100.0

    low_empathy_cases = sorted(evaluated, key=lambda x: float((x.get("scores") or {}).get("empathy") or 0.0))[:10]

    lines: List[str] = []
    lines.append("# Aurora Batch Evaluation Report")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Total cases: **{total}**")
    lines.append(f"- Pass: **{passed_count}**")
    lines.append(f"- Fail: **{fail_count}**")
    lines.append(f"- Pass rate: **{(passed_count / max(total, 1)) * 100:.2f}%**")
    lines.append(f"- Average weighted score: **{avg_total:.3f} / 5.0**")
    lines.append(f"- Average latency: **{avg_latency:.2f} ms**")
    lines.append(f"- Optimize call enabled: **{str(optimize_call).lower()}**")
    lines.append("")
    lines.append("### Key quality indicators")
    lines.append("")
    lines.append(f"- Safety gate trigger rate (`safety < 4.0`): **{safety_gate_rate:.2f}%** ({safety_gate_count}/{total})")
    lines.append(
        f"- Route structure compliance rate: **{route_compliance_rate:.2f}%** ({route_compliant}/{len(route_scored)})"
    )
    lines.append(
        f"- Clarification hit rate (when expected): **{clarification_rate:.2f}%** ({clarify_hit}/{len(clarify_required)})"
    )
    lines.append(
        f"- Over-conservative rate: **{over_conservative_rate:.2f}%** ({over_conservative_count}/{total})"
    )
    lines.append("")
    lines.append("### Lowest empathy (Top 10)")
    lines.append("")
    if low_empathy_cases:
        for case in low_empathy_cases:
            first_line = ((case.get("assistant_text") or "").strip().splitlines() or [""])[0][:120]
            lines.append(
                f"- `{case['case_id']}` route=`{case.get('entry_route')}` empathy={case['scores']['empathy']:.2f} | {first_line}"
            )
    else:
        lines.append("- None")
    lines.append("")
    lines.append("### Top failure reasons")
    lines.append("")
    if top_reasons:
        for reason, count in top_reasons:
            lines.append(f"- `{reason}`: {count}")
    else:
        lines.append("- None")
    lines.append("")
    lines.append("## Per-case Details")
    lines.append("")

    for item in evaluated:
        lines.append(f"### {item['case_id']}")
        lines.append("")
        lines.append(f"- Tags: `{', '.join(item.get('tags') or [])}`")
        lines.append(f"- Route: `{item.get('entry_route')}`")
        route_structure = item.get("route_structure") or {}
        lines.append(
            f"- Route structure: compliant={route_structure.get('compliant')} missing={','.join(route_structure.get('missing') or []) or 'none'}"
        )
        lines.append(f"- Card types: `{', '.join(item.get('card_types') or [])}`")
        lines.append(f"- Score: **{item['scores']['total']:.3f}** (pass={item['scores']['passed']})")
        lines.append(
            f"- Subscores: professionalism={item['scores']['professionalism']:.2f}, safety={item['scores']['safety']:.2f}, clarity={item['scores']['clarity']:.2f}, empathy={item['scores']['empathy']:.2f}"
        )
        lines.append(f"- Issues: `{', '.join(item.get('root_cause_tags') or ['none'])}`")
        lines.append("- Answer:")
        lines.append("")
        lines.append("```text")
        lines.append((item.get("assistant_text") or "").strip()[:4000])
        lines.append("```")
        if item.get("targeted_fix"):
            lines.append("- Targeted fix:")
            for fix in item["targeted_fix"]:
                lines.append(f"  - {fix}")
        if item.get("optimized_answer"):
            lines.append("- Optimized answer (rule-based):")
            lines.append("")
            lines.append("```text")
            lines.append(item["optimized_answer"][:4000])
            lines.append("```")
        if optimize_call:
            model_row = next((x for x in optimized_model_rows if x.get("case_id") == item["case_id"]), None)
            if model_row:
                lines.append("- Optimized answer (model call):")
                lines.append("")
                lines.append("```text")
                lines.append((model_row.get("optimized_model_answer") or "").strip()[:4000])
                lines.append("```")
                if model_row.get("optimize_error"):
                    lines.append(f"- Optimize call error: `{model_row['optimize_error']}`")
        lines.append("")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    print(report_path)
    if optimize_call:
        print(optimized_out_path)


if __name__ == "__main__":
    main()
