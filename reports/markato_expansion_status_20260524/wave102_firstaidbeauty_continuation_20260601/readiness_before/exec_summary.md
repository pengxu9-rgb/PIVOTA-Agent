# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T01:46:53.438Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave102_firstaidbeauty_continuation_20260601/readiness_before

## Executive Numbers

- Rows scanned: 2
- Terminal hold rows: 0
- Action-required rows: 2
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 2
- Public commerce doc groups built by dry-run: 2
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
| kb_blocked | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| firstaidbeauty.com | 2 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 2,
  "by_market": {
    "US": 2
  },
  "by_domain": [
    {
      "key": "firstaidbeauty.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 2
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 2,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 1
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 2
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 2,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "empty_watchouts",
        "count": 2
      },
      {
        "key": "not_displayable_gate",
        "count": 2
      },
      {
        "key": "not_reviewed",
        "count": 2
      },
      {
        "key": "quality_limited",
        "count": 2
      },
      {
        "key": "seller_only_evidence",
        "count": 2
      }
    ],
    "effective_issue_domains": [
      {
        "key": "firstaidbeauty.com::empty_watchouts",
        "count": 2
      },
      {
        "key": "firstaidbeauty.com::not_displayable_gate",
        "count": 2
      },
      {
        "key": "firstaidbeauty.com::not_reviewed",
        "count": 2
      },
      {
        "key": "firstaidbeauty.com::quality_limited",
        "count": 2
      },
      {
        "key": "firstaidbeauty.com::seller_only_evidence",
        "count": 2
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 2
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 2
      }
    ],
    "samples": {
      "not_reviewed": [
        {
          "external_product_id": "ext_8a021870d9ebe7c3dd0cb802",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Cream Intense Hydration",
          "used_product_id": "ext_8a021870d9ebe7c3dd0cb802",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_df3aa47a3d320882d6fe3ae3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Cream Intense Hydration Jumbo",
          "used_product_id": "ext_df3aa47a3d320882d6fe3ae3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "not_displayable_gate": [
        {
          "external_product_id": "ext_8a021870d9ebe7c3dd0cb802",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Cream Intense Hydration",
          "used_product_id": "ext_8a021870d9ebe7c3dd0cb802",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_df3aa47a3d320882d6fe3ae3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Cream Intense Hydration Jumbo",
          "used_product_id": "ext_df3aa47a3d320882d6fe3ae3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_8a021870d9ebe7c3dd0cb802",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Cream Intense Hydration",
          "used_product_id": "ext_8a021870d9ebe7c3dd0cb802",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_df3aa47a3d320882d6fe3ae3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Cream Intense Hydration Jumbo",
          "used_product_id": "ext_df3aa47a3d320882d6fe3ae3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 2,
    "status": [
      {
        "key": "ready_hero",
        "count": 2
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 2
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 2
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
