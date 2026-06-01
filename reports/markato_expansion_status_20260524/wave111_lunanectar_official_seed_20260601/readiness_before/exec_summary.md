# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:45:28.500Z

Scope: active external seeds, market=US, include_attached=true, limit=10

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave111_lunanectar_official_seed_20260601/readiness_before

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 0
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
| kb_blocked | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| lunanectar.com | 3 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "lunanectar.com",
      "count": 3
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 3,
    "missing_active_raw": 3,
    "missing_details": 1,
    "missing_how_to": 1,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "public_sensitive_claim",
        "count": 3
      },
      {
        "key": "public_truncated_copy",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "lunanectar.com::public_sensitive_claim",
        "count": 3
      },
      {
        "key": "lunanectar.com::public_truncated_copy",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 3
      }
    ],
    "samples": {
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_60b9ad953781f0fa6bf4b61e",
          "domain": "lunanectar.com",
          "title": "Exploration 01 Ampoule Repair Shampoo",
          "used_product_id": "ext_60b9ad953781f0fa6bf4b61e",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_c10190a05ba9f5bd651d3385",
          "domain": "lunanectar.com",
          "title": "Exploration 02 Ampoule Hydrating Conditioner",
          "used_product_id": "ext_c10190a05ba9f5bd651d3385",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_31649f8f88272f3a8d522c4d",
          "domain": "lunanectar.com",
          "title": "Moon Boost Eyebrow and Lash Serum",
          "used_product_id": "ext_31649f8f88272f3a8d522c4d",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        }
      ],
      "public_truncated_copy": [
        {
          "external_product_id": "ext_c10190a05ba9f5bd651d3385",
          "domain": "lunanectar.com",
          "title": "Exploration 02 Ampoule Hydrating Conditioner",
          "used_product_id": "ext_c10190a05ba9f5bd651d3385",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 1,
    "any_active_items": 0,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 2
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "lunanectar.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "none",
        "count": 3
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_60b9ad953781f0fa6bf4b61e",
          "domain": "lunanectar.com",
          "title": "Exploration 01 Ampoule Repair Shampoo",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 2
      },
      {
        "key": "no_visible_variant_axis",
        "count": 1
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
