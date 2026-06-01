# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T03:11:51.348Z

Scope: active external seeds, market=US, include_attached=true, limit=10

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave117_dermalogica_continuation_20260601/readiness_before

## Executive Numbers

- Rows scanned: 2
- Terminal hold rows: 0
- Action-required rows: 1
- DB Serving Ready rows: 1 (0.5)
- DB Serving Ready rows excluding terminal holds: 1 (0.5)
- External index published rows: 0
- Direct KB displayable rows: 1
- Direct KB high-quality-ready rows: 1
- Identity ready rows: 2
- Public commerce doc groups built by dry-run: 2
- Rows with public commerce doc + insight summary: 1
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
| db_serving_ready | 1 |
| kb_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| dermalogica.com | 2 | 0 | 1 | 0.5 | 0.5 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 2,
  "by_market": {
    "US": 2
  },
  "by_domain": [
    {
      "key": "dermalogica.com",
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
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 1
  },
  "pivota_insights": {
    "direct": {
      "displayable": 1,
      "high_quality_ready": 1,
      "missing_kb": 0,
      "not_displayable": 1
    },
    "effective": {
      "displayable": 1,
      "high_quality_ready": 1,
      "missing_kb": 0,
      "not_displayable": 1,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "ellipsis_or_truncated",
        "count": 1
      },
      {
        "key": "generic_copy_signal",
        "count": 1
      },
      {
        "key": "not_displayable_gate",
        "count": 1
      },
      {
        "key": "not_reviewed",
        "count": 1
      },
      {
        "key": "public_sensitive_claim",
        "count": 1
      },
      {
        "key": "public_truncated_copy",
        "count": 1
      },
      {
        "key": "quality_limited",
        "count": 1
      },
      {
        "key": "seller_only_evidence",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "dermalogica.com::ellipsis_or_truncated",
        "count": 1
      },
      {
        "key": "dermalogica.com::generic_copy_signal",
        "count": 1
      },
      {
        "key": "dermalogica.com::not_displayable_gate",
        "count": 1
      },
      {
        "key": "dermalogica.com::not_reviewed",
        "count": 1
      },
      {
        "key": "dermalogica.com::public_sensitive_claim",
        "count": 1
      },
      {
        "key": "dermalogica.com::public_truncated_copy",
        "count": 1
      },
      {
        "key": "dermalogica.com::quality_limited",
        "count": 1
      },
      {
        "key": "dermalogica.com::seller_only_evidence",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 1
      },
      {
        "key": "reviewed",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 1
      },
      {
        "key": "seller_plus_formula",
        "count": 1
      }
    ],
    "samples": {
      "not_reviewed": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "not_displayable_gate": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "ellipsis_or_truncated": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "generic_copy_signal": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "public_truncated_copy": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_eca8959862245d5af16ab206",
          "domain": "dermalogica.com",
          "title": "daily milkfoliant exfoliator",
          "used_product_id": "ext_eca8959862245d5af16ab206",
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
