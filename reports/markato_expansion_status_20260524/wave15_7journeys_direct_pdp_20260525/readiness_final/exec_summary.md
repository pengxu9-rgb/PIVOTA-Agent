# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T08:15:52.677Z

Scope: active external seeds, market=US, domain=7journeys.com, include_attached=true, limit=50

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave15_7journeys_direct_pdp_20260525/readiness_final

## Executive Numbers

- Rows scanned: 5
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 5 (1)
- DB Serving Ready rows excluding terminal holds: 5 (1)
- External index published rows: 0
- Direct KB displayable rows: 5
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 5
- Public commerce doc groups built by dry-run: 5
- Rows with public commerce doc + insight summary: 5
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5735 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 5 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 7journeys.com | 5 | 0 | 5 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 5,
  "by_market": {
    "US": 5
  },
  "by_domain": [
    {
      "key": "7journeys.com",
      "count": 5
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 5
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 5,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 5
  },
  "pivota_insights": {
    "direct": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 5
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 5
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 5,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 5
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 5
      }
    ],
    "issue_domains": [
      {
        "key": "7journeys.com::missing_hero",
        "count": 5
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 5
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_1e7b8274600d0395757a3b60",
          "domain": "7journeys.com",
          "title": "7 Journeys Miracle Timeless Eye Cream 30g (Hydrating & Glowing)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_299e2dc017565ab3081f8c26",
          "domain": "7journeys.com",
          "title": "7 Journeys Extra Soft Glow Renewal Moisturizer 50g - Hydrating & Firming",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_2da51d2f8d19211c89fb2a30",
          "domain": "7journeys.com",
          "title": "7 Journeys Miracle Glow Serum Mask 25ml (10 Sheets)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_718736656c3aa82e74546c28",
          "domain": "7journeys.com",
          "title": "7 Journeys Glow Renewal Serum 45ml (Hydrated & Glowing Skin)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_d55c93a9feb384ac9e0bde40",
          "domain": "7journeys.com",
          "title": "7 Journeys Antarctic Timeless Serum 45ml (Hydration & Anti-aging)",
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
        "count": 5
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
