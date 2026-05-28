# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T15:39:11.709Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave33_joujou_masami_serving_sync_20260527/readiness_before_serving_sync

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 3
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5766 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| index_doc_shadow_only | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| joujoubotanicals.com | 2 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| lovemasami.com | 1 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "joujoubotanicals.com",
      "count": 2
    },
    {
      "key": "lovemasami.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 3,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 2
      },
      {
        "key": "seller_plus_formula",
        "count": 1
      }
    ],
    "samples": {}
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
        "key": "joujoubotanicals.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "none",
        "count": 2
      },
      {
        "key": "pdp_section",
        "count": 1
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_de5c3d5849b1256eca4a7566",
          "domain": "joujoubotanicals.com",
          "title": "FLORAL FILTER Face Mask",
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
        "count": 3
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
