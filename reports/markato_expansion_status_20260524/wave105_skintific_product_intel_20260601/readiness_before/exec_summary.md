# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:11:12.192Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave105_skintific_product_intel_20260601/readiness_before

## Executive Numbers

- Rows scanned: 1
- Terminal hold rows: 0
- Action-required rows: 1
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 1
- Public commerce doc groups built by dry-run: 1
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
| kb_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| skintific.com | 1 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 1,
  "by_market": {
    "US": 1
  },
  "by_domain": [
    {
      "key": "skintific.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 1,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 0
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 1
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 1,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "quality_limited",
        "count": 1
      },
      {
        "key": "reviewed_not_displayable",
        "count": 1
      },
      {
        "key": "seller_only_evidence",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "skintific.com::quality_limited",
        "count": 1
      },
      {
        "key": "skintific.com::reviewed_not_displayable",
        "count": 1
      },
      {
        "key": "skintific.com::seller_only_evidence",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 1
      }
    ],
    "samples": {
      "reviewed_not_displayable": [
        {
          "external_product_id": "ext_4f3abc692059299f1ac3f12b",
          "domain": "skintific.com",
          "title": "Glow Cushion & Serum Spray Set 2pcs",
          "used_product_id": "ext_4f3abc692059299f1ac3f12b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_4f3abc692059299f1ac3f12b",
          "domain": "skintific.com",
          "title": "Glow Cushion & Serum Spray Set 2pcs",
          "used_product_id": "ext_4f3abc692059299f1ac3f12b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
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
        "count": 1
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
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
