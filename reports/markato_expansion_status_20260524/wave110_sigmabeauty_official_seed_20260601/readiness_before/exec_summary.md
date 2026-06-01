# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:44:39.904Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave110_sigmabeauty_official_seed_20260601/readiness_before

## Executive Numbers

- Rows scanned: 10
- Terminal hold rows: 0
- Action-required rows: 10
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 10
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 10
- Public commerce doc groups built by dry-run: 10
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5774 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| kb_blocked | 10 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| sigmabeauty.com | 10 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 10,
  "by_market": {
    "US": 10
  },
  "by_domain": [
    {
      "key": "sigmabeauty.com",
      "count": 10
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 7
    },
    {
      "key": "accessory",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 7,
    "missing_active_raw": 0,
    "missing_details": 2,
    "missing_how_to": 0,
    "missing_faq": 8
  },
  "pivota_insights": {
    "direct": {
      "displayable": 10,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 10,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "public_generic_marketing_copy",
        "count": 10
      }
    ],
    "effective_issue_domains": [
      {
        "key": "sigmabeauty.com::public_generic_marketing_copy",
        "count": 10
      }
    ],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 10
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 10
      }
    ],
    "samples": {
      "public_generic_marketing_copy": [
        {
          "external_product_id": "ext_4cf0e36c371cd934b3bbff7b",
          "domain": "sigmabeauty.com",
          "title": "3DHD® Kabuki Brush",
          "used_product_id": "ext_4cf0e36c371cd934b3bbff7b",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_32e78c6c9c240bda0f24a93d",
          "domain": "sigmabeauty.com",
          "title": "3DHD® Kabuki Brush",
          "used_product_id": "ext_32e78c6c9c240bda0f24a93d",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_86636b43d15301c1bce77f5e",
          "domain": "sigmabeauty.com",
          "title": "Best-Selling Eye Brush Trio",
          "used_product_id": "ext_86636b43d15301c1bce77f5e",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_7f1c98209c32ca048865bf00",
          "domain": "sigmabeauty.com",
          "title": "The Soft Blend Brush Set",
          "used_product_id": "ext_7f1c98209c32ca048865bf00",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_60ceac004c5e9db024f0b197",
          "domain": "sigmabeauty.com",
          "title": "Soft Coverage Brush Set",
          "used_product_id": "ext_60ceac004c5e9db024f0b197",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_04d58dae990499187f5b6aa2",
          "domain": "sigmabeauty.com",
          "title": "Flawless Finish Brush Set",
          "used_product_id": "ext_04d58dae990499187f5b6aa2",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_515512e3a0235423f827cbe1",
          "domain": "sigmabeauty.com",
          "title": "Flawless Brow Sculpting Brush Set",
          "used_product_id": "ext_515512e3a0235423f827cbe1",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_20396d956232fc08a1d08c5d",
          "domain": "sigmabeauty.com",
          "title": "Best-Selling Face Brush Trio",
          "used_product_id": "ext_20396d956232fc08a1d08c5d",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_22a1d804a55d6c321d33674f",
          "domain": "sigmabeauty.com",
          "title": "F79 Concealer Blend Kabuki™ Brush",
          "used_product_id": "ext_22a1d804a55d6c321d33674f",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_6881b94fb4dd6dcf5a08fb60",
          "domain": "sigmabeauty.com",
          "title": "Sigma Signature Set",
          "used_product_id": "ext_6881b94fb4dd6dcf5a08fb60",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 0,
    "any_active_items": 0,
    "status": [
      {
        "key": "not_applicable_product_family",
        "count": 10
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 10
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 10
      }
    ],
    "issues": [],
    "issue_domains": [],
    "samples": {}
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
