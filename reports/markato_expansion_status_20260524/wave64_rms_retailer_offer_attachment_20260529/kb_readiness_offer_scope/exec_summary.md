# KB x Commerce Index Readiness Audit

Generated: 2026-05-29T13:58:55.561Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave64_rms_retailer_offer_attachment_20260529/kb_readiness_offer_scope

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 2
- DB Serving Ready rows: 2 (0.5)
- DB Serving Ready rows excluding terminal holds: 2 (0.5)
- External index published rows: 0
- Direct KB displayable rows: 4
- Direct KB high-quality-ready rows: 4
- Identity ready rows: 2
- Public commerce doc groups built by dry-run: 2
- Rows with public commerce doc + insight summary: 2
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5771 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 2 |
| identity_blocked | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| dermstore.com | 2 | 0 | 0 | 0 | 0 | 0 | identity_blocked |
| rmsbeauty.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "dermstore.com",
      "count": 2
    },
    {
      "key": "rmsbeauty.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 2
    },
    {
      "key": "single_formula",
      "count": 2
    }
  ],
  "coverage": {
    "missing_inci": 1,
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 2
      },
      {
        "key": "verified",
        "count": 2
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_line",
        "count": 2
      },
      {
        "key": "seller_plus_formula",
        "count": 2
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 1,
    "status": [
      {
        "key": "not_applicable_product_family",
        "count": 2
      },
      {
        "key": "missing_hero",
        "count": 1
      },
      {
        "key": "ready_hero",
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
        "key": "dermstore.com::missing_hero",
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
        "count": 2
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_b8af61a562f4ab972197f413",
          "domain": "dermstore.com",
          "title": "RMS Beauty Revitalize Hydra Concealer 0.17fl oz (Various Shades)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 4
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
