# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:30:56.189Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave109_firstaidbeauty_missing_card_20260601/readiness_before

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 3
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
| kb_blocked | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| firstaidbeauty.com | 3 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "firstaidbeauty.com",
      "count": 3
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
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 1
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 3
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 3,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_card_highlight",
        "count": 3
      },
      {
        "key": "not_displayable_gate",
        "count": 3
      },
      {
        "key": "not_reviewed",
        "count": 3
      },
      {
        "key": "quality_limited",
        "count": 3
      },
      {
        "key": "seller_only_evidence",
        "count": 3
      }
    ],
    "effective_issue_domains": [
      {
        "key": "firstaidbeauty.com::missing_card_highlight",
        "count": 3
      },
      {
        "key": "firstaidbeauty.com::not_displayable_gate",
        "count": 3
      },
      {
        "key": "firstaidbeauty.com::not_reviewed",
        "count": 3
      },
      {
        "key": "firstaidbeauty.com::quality_limited",
        "count": 3
      },
      {
        "key": "firstaidbeauty.com::seller_only_evidence",
        "count": 3
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 3
      }
    ],
    "samples": {
      "not_reviewed": [
        {
          "external_product_id": "ext_95582fd1ed491684223018bb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Oil-Control Moisturizer",
          "used_product_id": "ext_95582fd1ed491684223018bb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Face Lotion with Colloidal Oatmeal",
          "used_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "not_displayable_gate": [
        {
          "external_product_id": "ext_95582fd1ed491684223018bb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Oil-Control Moisturizer",
          "used_product_id": "ext_95582fd1ed491684223018bb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Face Lotion with Colloidal Oatmeal",
          "used_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "missing_card_highlight": [
        {
          "external_product_id": "ext_95582fd1ed491684223018bb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Oil-Control Moisturizer",
          "used_product_id": "ext_95582fd1ed491684223018bb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Face Lotion with Colloidal Oatmeal",
          "used_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_95582fd1ed491684223018bb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Oil-Control Moisturizer",
          "used_product_id": "ext_95582fd1ed491684223018bb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Face Lotion with Colloidal Oatmeal",
          "used_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 1,
    "any_active_items": 3,
    "status": [
      {
        "key": "ready_other",
        "count": 2
      },
      {
        "key": "ready_hero",
        "count": 1
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 3
      }
    ],
    "samples": {}
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
