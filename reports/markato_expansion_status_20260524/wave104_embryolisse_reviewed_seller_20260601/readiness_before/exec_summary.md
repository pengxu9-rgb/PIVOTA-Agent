# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:08:09.566Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave104_embryolisse_reviewed_seller_20260601/readiness_before

## Executive Numbers

- Rows scanned: 2
- Terminal hold rows: 0
- Action-required rows: 2
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 1
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
| kb_blocked | 1 |
| kb_displayable_limited | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| us.embryolisse.com | 2 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 2,
  "by_market": {
    "US": 2
  },
  "by_domain": [
    {
      "key": "us.embryolisse.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 2
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 0,
    "missing_details": 2,
    "missing_how_to": 0,
    "missing_faq": 2
  },
  "pivota_insights": {
    "direct": {
      "displayable": 1,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 1
    },
    "effective": {
      "displayable": 1,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 1,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "empty_watchouts",
        "count": 2
      },
      {
        "key": "quality_limited",
        "count": 2
      },
      {
        "key": "seller_only_evidence",
        "count": 2
      },
      {
        "key": "missing_card_highlight",
        "count": 1
      },
      {
        "key": "reviewed_not_displayable",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "us.embryolisse.com::empty_watchouts",
        "count": 2
      },
      {
        "key": "us.embryolisse.com::quality_limited",
        "count": 2
      },
      {
        "key": "us.embryolisse.com::seller_only_evidence",
        "count": 2
      },
      {
        "key": "us.embryolisse.com::missing_card_highlight",
        "count": 1
      },
      {
        "key": "us.embryolisse.com::reviewed_not_displayable",
        "count": 1
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
      "missing_card_highlight": [
        {
          "external_product_id": "ext_fcf56da89f53b3a37076606a",
          "domain": "us.embryolisse.com",
          "title": "AM/PM routine",
          "used_product_id": "ext_fcf56da89f53b3a37076606a",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_fcf56da89f53b3a37076606a",
          "domain": "us.embryolisse.com",
          "title": "AM/PM routine",
          "used_product_id": "ext_fcf56da89f53b3a37076606a",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_5e2a19baf6e9780ad5e8ff66",
          "domain": "us.embryolisse.com",
          "title": "Carry-on Lait-Crème Set",
          "used_product_id": "ext_5e2a19baf6e9780ad5e8ff66",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "reviewed_not_displayable": [
        {
          "external_product_id": "ext_5e2a19baf6e9780ad5e8ff66",
          "domain": "us.embryolisse.com",
          "title": "Carry-on Lait-Crème Set",
          "used_product_id": "ext_5e2a19baf6e9780ad5e8ff66",
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
        "count": 2
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
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
