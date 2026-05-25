# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T14:03:27.346Z

Scope: active external seeds, market=US, domain=abyssianhaircare.com, include_attached=true, limit=50

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave18_direct_source_probe_20260525/readiness_after_catalog_sync

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
| US | 5750 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| kb_missing | 6 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| abyssianhaircare.com | 6 | 0 | 0 | 0 | 0 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 6,
  "by_market": {
    "US": 6
  },
  "by_domain": [
    {
      "key": "abyssianhaircare.com",
      "count": 6
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 6
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 6,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 6
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 6,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 6,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 6
      }
    ],
    "effective_issue_domains": [
      {
        "key": "abyssianhaircare.com::missing_kb",
        "count": 6
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 6
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 6
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_3508560cf76c6d564d97f6d0",
          "domain": "abyssianhaircare.com",
          "title": "Dream Bonds Bio Emulsion",
          "used_product_id": "ext_3508560cf76c6d564d97f6d0",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_3916e5e378df1e75041a1b68",
          "domain": "abyssianhaircare.com",
          "title": "Daily Shield Superfood Conditioner",
          "used_product_id": "ext_3916e5e378df1e75041a1b68",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_443039d2322b0af440c1ce9a",
          "domain": "abyssianhaircare.com",
          "title": "Solar Glow Dry Shampoo",
          "used_product_id": "ext_443039d2322b0af440c1ce9a",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_6cb55d2964fca74dbcade8e7",
          "domain": "abyssianhaircare.com",
          "title": "Nano Repair Shampoo",
          "used_product_id": "ext_6cb55d2964fca74dbcade8e7",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_ac6c6e795d7f3efe5cc22f7c",
          "domain": "abyssianhaircare.com",
          "title": "Youth Bloom Hair Mist",
          "used_product_id": "ext_ac6c6e795d7f3efe5cc22f7c",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_d8737399fc72ef06c147bd0c",
          "domain": "abyssianhaircare.com",
          "title": "Protein Shake Hair Mask",
          "used_product_id": "ext_d8737399fc72ef06c147bd0c",
          "quality_state": "missing",
          "evidence_profile": "missing"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 5,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 5
      },
      {
        "key": "not_expected_missing",
        "count": 1
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
        "key": "abyssianhaircare.com::missing_hero",
        "count": 5
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 6
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_3508560cf76c6d564d97f6d0",
          "domain": "abyssianhaircare.com",
          "title": "Dream Bonds Bio Emulsion",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_3916e5e378df1e75041a1b68",
          "domain": "abyssianhaircare.com",
          "title": "Daily Shield Superfood Conditioner",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_6cb55d2964fca74dbcade8e7",
          "domain": "abyssianhaircare.com",
          "title": "Nano Repair Shampoo",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_ac6c6e795d7f3efe5cc22f7c",
          "domain": "abyssianhaircare.com",
          "title": "Youth Bloom Hair Mist",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_d8737399fc72ef06c147bd0c",
          "domain": "abyssianhaircare.com",
          "title": "Protein Shake Hair Mask",
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
