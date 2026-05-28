# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T01:29:20.074Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave37_joocyee_same_canonical_product_line_20260528/readiness_after_product_intel_all14

## Executive Numbers

- Rows scanned: 14
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 11 (0.7857)
- DB Serving Ready rows excluding terminal holds: 11 (0.7857)
- External index published rows: 0
- Direct KB displayable rows: 12
- Direct KB high-quality-ready rows: 12
- Identity ready rows: 14
- Public commerce doc groups built by dry-run: 10
- Rows with public commerce doc + insight summary: 11
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
| db_serving_ready | 11 |
| kb_missing | 2 |
| index_doc_shadow_only | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| joocyee.com | 14 | 0 | 11 | 0.7857 | 0.7857 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 14,
  "by_market": {
    "US": 14
  },
  "by_domain": [
    {
      "key": "joocyee.com",
      "count": 14
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 14
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 14
  },
  "pivota_insights": {
    "direct": {
      "displayable": 12,
      "high_quality_ready": 12,
      "missing_kb": 2,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 14,
      "high_quality_ready": 14,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 2
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 14
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 14
      }
    ],
    "samples": {
      "borrowed_from_sibling": [
        {
          "external_product_id": "ext_8bced3f34a8100c3cfa62377",
          "domain": "joocyee.com",
          "title": "Color-correcting Primer",
          "used_product_id": "ext_794deab047eb4a75225329df",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_3ca7c85748b01b4bc8e2f3bb",
          "domain": "joocyee.com",
          "title": "Color-correcting Primer",
          "used_product_id": "ext_794deab047eb4a75225329df",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 14,
    "any_active_items": 14,
    "status": [
      {
        "key": "ready_hero",
        "count": 14
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 14
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 14
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
