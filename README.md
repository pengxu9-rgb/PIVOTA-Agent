# Pivota Shopping Agent

A unified gateway for AI-powered shopping experiences, integrating with Pivota Infrastructure, ACP (Agentic Commerce Protocol), and AP2 (Agent Payments Protocol).

## Overview

The Pivota Shopping Agent provides a standardized interface for Large Language Models (LLMs) to perform shopping operations on behalf of users. It acts as a gateway between AI agents and the Pivota commerce platform.

## Features

- 🛍️ **Unified Shopping Operations**: Search products, create orders, process payments, track shipments, and handle after-sales
- 🤖 **LLM-Optimized**: Designed for integration with ChatGPT, Claude, Gemini, and other AI platforms
- 🔐 **Secure Gateway**: Handles authentication and request routing to Pivota Infrastructure
- 🌐 **Protocol Support**: Native support for ACP and AP2 protocols
- 🧪 **Development Mode**: Includes mock API for testing without real transactions

## Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Pivota API credentials (get from Pivota console)
- OpenAI API key (optional, for demo)

### Installation

```bash
# Clone the repository
git clone https://github.com/pengxu9-rgb/PIVOTA-Agent.git
cd PIVOTA-Agent

# Install dependencies
npm install

# Copy environment template
cp env.example .env

# Edit .env with your credentials
# PIVOTA_API_KEY=<your-key>
# OPENAI_API_KEY=<your-key>
```

### Running the Gateway

```bash
# Start with mock API (development)
npm run mock:pivota  # Terminal 1
npm start           # Terminal 2

# Or start with real API (production)
npm start
```

The gateway will be available at `http://localhost:3000`

### Testing

```bash
# Run unit tests
npm test

# Run OpenAI demo
npm run demo:openai

# Check order status demo
npm run demo:status
```

## API Reference

### Main Endpoint

```
POST /agent/shop/v1/invoke
```

Accepts operations:
- `find_products` - Search for products
- `get_product_detail` - Get product details
- `create_order` - Create a shopping order
- `submit_payment` - Process payment
- `get_order_status` - Track order status
- `request_after_sales` - Handle returns/refunds

See [API Mapping Documentation](docs/pivota-api-mapping.md) for details.

### Look Replicator Endpoints (agent task)

These endpoints support the `pengxu9-rgb/look-replicate-share` frontend:

- `POST /uploads/signed-url` (signed direct uploads for 1–10MB images)
- `POST /look-jobs` (create job; expects `referenceImageUrl` and optional `selfieImageUrl`)
- `GET /look-jobs/:jobId` (poll)
- `GET /shares/:shareId` (share landing payload)

Configure env vars in `env.example` under `LOOK_REPLICATOR_*`. In production, set `LOOK_REPLICATOR_API_KEY` and require callers to send `Authorization: Bearer ...`.

## LLM Integration Guides

- [ChatGPT / OpenAI](docs/integrations/chatgpt.md) - Complete guide
- [Google Gemini](docs/integrations/gemini.md) - Coming soon
- [Anthropic Claude](docs/integrations/claude.md) - Coming soon
- [Perplexity](docs/integrations/perplexity.md) - Coming soon
- [Qwen (通义千问)](docs/integrations/qwen.md) - Coming soon
- [DeepSeek](docs/integrations/deepseek.md) - Coming soon

## Documentation

- [System Prompt](docs/prompt-system.md) - LLM instructions (v1.0)
- [Tool Schema](docs/tool-schema.json) - Function calling schema (v1.0)
- [API Mapping](docs/pivota-api-mapping.md) - Gateway to Pivota API mapping
- [ACP Protocol](docs/acp-spec-bridge.md) - Commerce protocol handling
- [AP2 Protocol](docs/ap2-spec-bridge.md) - Payment protocol handling
- [Deployment Guide](docs/deployment.md) - Production deployment
- [Gold Labeling Guide](docs/GOLD_LABELING_GUIDE.md) - Aurora Round1 labeling/eval/gate workflow

## Round1 Labeling To Gate (Aurora)

Quick entry for the human Round1 closed loop:

```bash
# 1) Generate executable runbook + seed-pack instructions
make gold-round1-runbook RUN_ID=<run_id> REVIEW_JSONL=reports/review_pack_mixed_<run_id>.jsonl

# 2) Import real Label Studio export (with QC report)
make gold-label-import ROUND1_IN=artifacts/gold_round1_real_<run_id>/label_studio_export_round1_<run_id>.json OUT=artifacts/gold_round1_real_<run_id>/gold_labels.ndjson

# 3) Gold eval + AB + IAA + crossset
make eval-gold-round1 GOLD_LABELS=artifacts/gold_round1_real_<run_id>/gold_labels.ndjson PRED_JSONL=reports/review_pack_mixed_<run_id>.jsonl
make eval-gold-ab GOLD_LABELS=artifacts/gold_round1_real_<run_id>/gold_labels.ndjson PRED_JSONL=reports/review_pack_mixed_<run_id>.jsonl
make eval-gold-iaa RUN_ID=<run_id> LS_EXPORT=artifacts/gold_round1_real_<run_id>/label_studio_export_round1_<run_id>.json
make eval-circle-crossset LIMIT=150

# 4) Release gate report (PASS/FAIL + recommended params)
make release-gate-circle RUN_ID=<run_id> LS_EXPORT=artifacts/gold_round1_real_<run_id>/label_studio_export_round1_<run_id>.json REVIEW_JSONL=reports/review_pack_mixed_<run_id>.jsonl LIMIT=150
```

Final gate artifact:
- `reports/RELEASE_GATE_CIRCLE_<run_id>.md`

## Preference Labeling v1 (Aurora)

Quick entry for Step 2 real A/B preference labeling (offline only, no production payload changes):

```bash
# 1) Build real round1 pack (baseline vs variant1), deterministic blind A/B flip.
#    Outputs:
#    - tasks_batch_a.json / tasks_batch_b.json / tasks_overlap.json / tasks_all.json
make preference-round1-real-pack \
  RUN_ID=<run_id> \
  INTERNAL_DIR="/absolute/path/to/internal_clean_photos" \
  REVIEW_PACK_JSONL=reports/review_pack_mixed_<run_id>.jsonl \
  LIMIT_INTERNAL=60 LIMIT_LAPA=70 LIMIT_CELEBA=70 TARGET_TOTAL=200 \
  OVERLAP_RATIO=0.25 OVERLAP_MIN=40 \
  PREFERENCE_MODULE_BOX_MODE=dynamic_skinmask \
  PREFERENCE_REQUIRE_DYNAMIC_BOXES=true \
  PREFERENCE_MIN_GEOMETRY_QC_SCORE=0.2 \
  PREFERENCE_HARD_FILTER_GATE=true \
  PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS=true \
  PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES=1 \
  PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS=48 \
  PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE=0.7

# Visual-separability focused sweep (contour-diff inset clarity):
make preference-round1-real-pack \
  RUN_ID=<run_id> \
  INTERNAL_DIR="/absolute/path/to/internal_clean_photos" \
  REVIEW_PACK_JSONL=reports/review_pack_mixed_<run_id>.jsonl \
  TARGET_TOTAL=80 PREFERENCE_MAX_EDGE=768 \
  PREFERENCE_REQUIRE_DYNAMIC_BOXES=true \
  OVERLAP_RATIO=0.25 OVERLAP_MIN=40

# 2) Label in Label Studio with:
#    label_studio/project_preference_ab.xml
# 3) Assignment suggestion:
#    - Annotator A uses tasks_batch_a.json
#    - Annotator B uses tasks_batch_b.json
#    - Overlap is guaranteed by tasks_overlap.json
# 4) Export JSON(s) from Label Studio:
#    artifacts/preference_round1_<run_id>/label_studio_export_preference_<run_id>.json

# 5) Import labels (manifest-aware unflip + confidence/reasons/QC)
make preference-label-import \
  RUN_ID=<run_id> \
  ROUND1_IN=artifacts/preference_round1_<run_id>/label_studio_export_preference_<run_id>.json \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  OUT=artifacts/preference_round1_<run_id>/preference_labels.ndjson

# 6) Evaluate wins/ties/cannot_tell + per-module + overlap IAA + CI + Top50 contentious
make eval-preference \
  RUN_ID=<run_id> \
  PREFERENCE_LABELS=artifacts/preference_round1_<run_id>/preference_labels.ndjson \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json

# 7) Build adjudication pack (labeled baseline/variant1 overlays, not blind)
make preference-adjudication-pack \
  RUN_ID=<run_id> \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  OUT=artifacts/preference_round1_<run_id>/adjudication

# 8) Release gate (SHIP_VARIANT1 | KEEP_BASELINE | NEED_ADJUDICATION)
make release-gate-preference \
  RUN_ID=<run_id> \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl \
  EVAL_MD=reports/eval_preference_<run_id>.md \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json

# 9) Step 3 (adjudication merge + final gate), multi-export friendly:
#    BASE exports are usually: batch_a + batch_b + overlap
make preference-final \
  RUN_ID=<run_id> \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  BASE_EXPORTS="artifacts/preference_round1_<run_id>/label_studio_export_batch_a_<run_id>.json,artifacts/preference_round1_<run_id>/label_studio_export_batch_b_<run_id>.json,artifacts/preference_round1_<run_id>/label_studio_export_overlap_<run_id>.json" \
  ADJ_EXPORTS="artifacts/preference_round1_<run_id>/adjudication/label_studio_export_adjudication_<run_id>.json"

# Optional explicit split commands used by preference-final internally:
make preference-import EXPORTS="<base_export_1.json>,<base_export_2.json>" MANIFEST=artifacts/preference_round1_<run_id>/manifest.json OUT=artifacts/preference_round1_<run_id>/final/base_labels.ndjson
make preference-adjudication-merge BASE=artifacts/preference_round1_<run_id>/final/base_labels.ndjson ADJ=artifacts/preference_round1_<run_id>/final/adjudication_labels.ndjson OUT=artifacts/preference_round1_<run_id>/final/preference_labels_merged.ndjson

# 10) Preference diagnostics report (why variant/base wins + disagreement drivers + next actions)
#     Includes overlay consistency gate (manifest vs eval_preference jsonl).
make preference-diagnostics \
  RUN_ID=<run_id> \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl \
  LABELS=artifacts/preference_round1_<run_id>/final/preference_labels_merged.ndjson \
  CROSSSET_JSONL=reports/eval_circle_crossset_<run_id>.jsonl

# Optional standalone overlay consistency gate
make preference-overlay-gate \
  RUN_ID=<run_id> \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl

# 11) Auto-propose next AB variants + build targeted Round2 pack
#     Outputs:
#     - artifacts/preference_round2_<next_run_id>/candidates.json
#     - artifacts/preference_round2_<next_run_id>/recommended.json
#     - artifacts/preference_round2_<next_run_id>/tasks.json + manifest.json
make preference-next-variants \
  RUN_ID=<round1_run_id> \
  CONTENTIOUS=artifacts/preference_contentious_<round1_run_id>.jsonl \
  MANIFEST=artifacts/preference_round1_<round1_run_id>/manifest.json \
  NEXT_RUN_ID=<round2_run_id> \
  TOP_K=4 TARGET_TOTAL=120 OVERLAP_RATIO=0.25 OVERLAP_MIN=24 \
  OVERLAY_DIFF_MIN=0.01 OVERLAY_DIFF_PRIORITY_WEIGHT=1 \
  CROSSSET_JSONL=reports/eval_circle_crossset_<run_id>.jsonl

# If proposer warns overlay_diff missing_rate > 0.05, rerun diagnostics gate first.
```

Smoke run suggestion (deterministic):
```bash
make preference-round1-real-pack RUN_ID=<run_id> INTERNAL_DIR=<internal_dir> EXTERNAL_INDEX_LAPA=<lapa_index_jsonl> EXTERNAL_INDEX_CELEBA=<celeba_index_jsonl> LIMIT_INTERNAL=5 LIMIT_LAPA=5 LIMIT_CELEBA=5 TARGET_TOTAL=20 OVERLAP_RATIO=0.3 OVERLAP_MIN=6 PREFERENCE_MAX_EDGE=768 MOCK_PIPELINE=true
```

## Project Structure

```
PIVOTA-Agent/
├── src/
│   ├── server.js      # Main gateway server
│   ├── schema.js      # Request validation schemas
│   └── logger.js      # Structured logging
├── scripts/
│   ├── mock-pivota-api.js     # Mock API for development
│   ├── demo-openai-pivota.mjs # OpenAI integration demo
│   └── demo-openai-status.mjs # Order status demo
├── docs/
│   ├── integrations/  # LLM platform guides
│   └── *.md          # Documentation
├── tests/            # Test suites
└── public/           # Web UI
```

## Security

- API keys are managed via environment variables
- Never commit `.env` files
- Use test merchants for development
- See [Deployment Guide](docs/deployment.md) for production security

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

- GitHub Issues: [Report bugs or request features](https://github.com/pengxu9-rgb/PIVOTA-Agent/issues)
- Documentation: Check the `/docs` directory
- Pivota Platform: [https://agents.pivota.cc](https://agents.pivota.cc)

## Acknowledgments

Built with:
- Express.js for the gateway server
- Zod for schema validation
- Pino for structured logging
- OpenAI SDK for demo integration

---

**Note**: This project is in active development. APIs and interfaces may change. Always refer to the version tags and documentation for stable releases.
