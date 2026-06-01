# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:04:41.291Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave103_jurlique_product_intel_20260601/readiness_before

## Executive Numbers

- Rows scanned: 6
- Terminal hold rows: 0
- Action-required rows: 6
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 6
- Public commerce doc groups built by dry-run: 6
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
| kb_blocked | 6 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| www.jurlique.com | 6 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 6,
  "by_market": {
    "US": 6
  },
  "by_domain": [
    {
      "key": "www.jurlique.com",
      "count": 6
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 6
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 6
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 6
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 6,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "quality_eligible",
        "count": 6
      },
      {
        "key": "reviewed_not_displayable",
        "count": 6
      }
    ],
    "effective_issue_domains": [
      {
        "key": "www.jurlique.com::quality_eligible",
        "count": 6
      },
      {
        "key": "www.jurlique.com::reviewed_not_displayable",
        "count": 6
      }
    ],
    "quality_state": [
      {
        "key": "eligible",
        "count": 6
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 6
      }
    ],
    "samples": {
      "reviewed_not_displayable": [
        {
          "external_product_id": "ext_1e20d9aa6fe78b783fddf311",
          "domain": "www.jurlique.com",
          "title": "Herbal Recovery Duo",
          "used_product_id": "ext_1e20d9aa6fe78b783fddf311",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_63ac501ca2ee5eb62b04dc41",
          "domain": "www.jurlique.com",
          "title": "8+2 Firm & Hydrate Duo",
          "used_product_id": "ext_63ac501ca2ee5eb62b04dc41",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_a4457d05bf56f811a88becf3",
          "domain": "www.jurlique.com",
          "title": "Perfect Prep Duo",
          "used_product_id": "ext_a4457d05bf56f811a88becf3",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_b0f9384195c88efc4aa0114e",
          "domain": "www.jurlique.com",
          "title": "Iconic Duo Bundle",
          "used_product_id": "ext_b0f9384195c88efc4aa0114e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_59d1d0f9b80d3ad401ad4862",
          "domain": "www.jurlique.com",
          "title": "Rejuvenating Duo",
          "used_product_id": "ext_59d1d0f9b80d3ad401ad4862",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_4da676febaab206c32ffac68",
          "domain": "www.jurlique.com",
          "title": "Soft Hand & Body Bundle",
          "used_product_id": "ext_4da676febaab206c32ffac68",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
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
        "count": 6
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 6
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 6
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
