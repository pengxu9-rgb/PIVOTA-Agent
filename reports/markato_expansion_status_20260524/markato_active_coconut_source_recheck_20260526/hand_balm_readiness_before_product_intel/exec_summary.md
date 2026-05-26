# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T13:00:55.262Z

Scope: active external seeds, market=US, include_attached=true, limit=1

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/markato_active_coconut_source_recheck_20260526/hand_balm_readiness_before_product_intel

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
| US | 5764 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| kb_missing | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| coconutmatter.com | 1 | 0 | 0 | 0 | 0 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 1,
  "by_market": {
    "US": 1
  },
  "by_domain": [
    {
      "key": "coconutmatter.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 1,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 1
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 1,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 1,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "coconutmatter.com::missing_kb",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 1
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_fda8be630c6dc79ef599df3c",
          "domain": "coconutmatter.com",
          "title": "NOURISHING HAND BALM",
          "used_product_id": "ext_fda8be630c6dc79ef599df3c",
          "quality_state": "missing",
          "evidence_profile": "missing"
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
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 1
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
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
