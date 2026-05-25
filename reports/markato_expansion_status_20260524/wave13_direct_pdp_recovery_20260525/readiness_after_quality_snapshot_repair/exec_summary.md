# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T05:29:34.170Z

Scope: active external seeds, market=US, domain=lovemasami.com, include_attached=true, limit=100

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave13_direct_pdp_recovery_20260525/readiness_after_quality_snapshot_repair

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 4
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 4
- Public commerce doc groups built by dry-run: 4
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5722 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| kb_missing | 4 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| lovemasami.com | 4 | 0 | 0 | 0 | 0 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "lovemasami.com",
      "count": 4
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 4
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 4,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 4,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 4
      }
    ],
    "effective_issue_domains": [
      {
        "key": "lovemasami.com::missing_kb",
        "count": 4
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 4
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 4
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_53cf4f0ee46873d280f632db",
          "domain": "lovemasami.com",
          "title": "Mekabu Hydrating Shine Serum",
          "used_product_id": "ext_53cf4f0ee46873d280f632db",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_96a7ecc1003f0f94e5b6805c",
          "domain": "lovemasami.com",
          "title": "Mekabu Hydrating Shampoo",
          "used_product_id": "ext_96a7ecc1003f0f94e5b6805c",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_a1bb997d38b6823e83f23948",
          "domain": "lovemasami.com",
          "title": "Mekabu Hydrating Conditioner",
          "used_product_id": "ext_a1bb997d38b6823e83f23948",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_fe9ef8f2a6343901489fe63e",
          "domain": "lovemasami.com",
          "title": "Mekabu Hydrating Styling Cream",
          "used_product_id": "ext_fe9ef8f2a6343901489fe63e",
          "quality_state": "missing",
          "evidence_profile": "missing"
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
      },
      {
        "key": "low_signal_active",
        "count": 1
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "low_signal_active",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "lovemasami.com::low_signal_active",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 4
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_96a7ecc1003f0f94e5b6805c",
          "domain": "lovemasami.com",
          "title": "Mekabu Hydrating Shampoo",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 3
      },
      {
        "key": "ready",
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
