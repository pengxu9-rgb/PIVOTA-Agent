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

### Test Stability Guardrails

- Use Node 20 (`nvm use` reads `.nvmrc`).
- Run tests only from this project root. Do not run tests from any `_deploy_tmp_*` directory.
- Prefer a local non-cloud path (for example `~/dev/...`) instead of Desktop-managed sync folders.
- Run `npm run test:preflight` before troubleshooting any test issue.
- Use `npm run test:file -- <path>` to auto-route by runner:
  - `*.node.test.cjs` -> `node --test`
  - `*.test.js` / `*.test.ts` -> `jest`

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
- [Deploy Policy (GitHub Push Only)](docs/runbooks/deploy_via_github_push_only.md) - Production source-of-truth workflow

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
