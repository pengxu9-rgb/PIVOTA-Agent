# Pivota Agent Gateway Deployment Guide

**Version: 1.0**  
*Production deployment guide for Pivota Shopping Agent Gateway*

## Overview

This guide covers deploying the Pivota Agent Gateway to production environments, with a focus on Railway deployment and general best practices.

## Environment Variables

Create a `.env` file from the template:
```bash
cp env.example .env
```

Required environment variables:
```bash
# Server Configuration
PORT=3000                              # Server port

# Pivota API Configuration  
PIVOTA_API_BASE=<your-pivota-api-url>  # e.g., https://web-production-fedb.up.railway.app
PIVOTA_API_KEY=<your-api-key>          # From Pivota console

# OpenAI Configuration (for /ui/chat)
OPENAI_API_KEY=<your-openai-key>      # From platform.openai.com

# Gateway Configuration
PIVOTA_GATEWAY_URL=<your-gateway-url>  # e.g., https://your-domain.com/agent/shop/v1/invoke

# Operation Mode
MODE=test                              # Use 'production' for real transactions
USE_MOCK=false                         # Set to 'true' for local development

# Optional
LOG_LEVEL=info                         # debug, info, warn, error
TEST_MERCHANT_ID=<test-merchant-id>   # For safe testing
TEST_AGENT_ID=<test-agent-id>         # For agent identification
```

### Aurora Chat V2 KB v0 production defaults

For Aurora BFF production rollout, set:

```bash
AURORA_KB_V0_DISABLE=0
AURORA_KB_FAIL_MODE=closed
```

Emergency-only operations:

```bash
# Full rollback to legacy-only path
AURORA_KB_V0_DISABLE=1

# Temporary fail-open (use only during KB integrity incidents)
AURORA_KB_FAIL_MODE=open
```

### Look Replicator (optional)

If you are deploying this gateway to support the `pengxu9-rgb/look-replicate-share` app (large image uploads + job polling), also set:

```bash
# Require callers to send: Authorization: Bearer <token>
LOOK_REPLICATOR_API_KEY=<strong-random-token>

# Pivota backend (where orders/quotes/ACP live)
# This service keeps the Agent API key server-side and proxies UI requests to pivota-backend.
PIVOTA_BACKEND_BASE_URL=https://web-production-fedb.up.railway.app
PIVOTA_API_KEY=ak_live_...                   # (or SHOP_GATEWAY_AGENT_API_KEY / PIVOTA_AGENT_API_KEY)

# Upload policy (1–10MB selfies are expected; default max is 25MB)
LOOK_REPLICATOR_MAX_UPLOAD_BYTES=26214400
LOOK_REPLICATOR_SIGNED_URL_TTL_SECONDS=300

# S3-compatible storage (Cloudflare R2 recommended)
LOOK_REPLICATOR_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
LOOK_REPLICATOR_S3_REGION=auto
LOOK_REPLICATOR_S3_BUCKET=<bucket>
LOOK_REPLICATOR_S3_ACCESS_KEY_ID=<key>
LOOK_REPLICATOR_S3_SECRET_ACCESS_KEY=<secret>

# Public base used to form returned publicUrl (e.g. https://<bucket>.r2.dev or custom domain)
LOOK_REPLICATOR_PUBLIC_ASSET_BASE_URL=https://<public-domain>
```

#### Identity bridging (Agent tools login → Pivota order attribution)

- Client can send an end-user token via `X-Agent-User-JWT` (JWT signed by the Agent tools provider).
- The gateway forwards `X-Agent-User-JWT` and/or `buyer_ref` to `pivota-backend` for:
  - `POST /agent/v1/checkout/acp-session` (checkout session metadata)
  - `GET /agent/v1/orders*` (orders list/detail/events filtering)
- Configure JWKS verification on `pivota-backend` (not in this gateway) using `AGENT_USER_JWKS_URL` + issuer/audience settings.

For share persistence across restarts, configure `DATABASE_URL` (Postgres). Without it, look jobs and shares are stored in-memory.

## Deployment Options

### Option 1: Railway (Recommended)

#### Prerequisites
- [Railway account](https://railway.app)
- GitHub repository connected
- Environment variables configured

#### Steps

1. **Connect GitHub Repository**
   ```bash
   # Ensure your code is pushed to GitHub
   git remote add origin https://github.com/pengxu9-rgb/PIVOTA-Agent.git
   git push -u origin main
   ```

2. **Create New Railway Project**
   - Go to [Railway Dashboard](https://railway.app/dashboard)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect Node.js

3. **Configure Environment Variables**
   - Go to Project Settings → Variables
   - Add all required environment variables
   - Use Railway's secret management for sensitive values

4. **Configure Health Check**
   - Settings → Health Check
   - Path: `/healthz`
   - Method: `GET`
   - Timeout: 30s

5. **Deploy**
   - Railway will automatically deploy on push
   - Monitor deployment in the dashboard
   - Check logs for startup confirmation

#### Railway-Specific Configuration

```json
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 30
  }
}
```

### Option 2: Docker Deployment

#### Build and Run
```bash
# Build Docker image
docker build -t pivota-agent-gateway .

# Run with environment variables
docker run -p 3000:3000 \
  -e PIVOTA_API_BASE=<your-api-base> \
  -e PIVOTA_API_KEY=<your-api-key> \
  -e OPENAI_API_KEY=<your-openai-key> \
  pivota-agent-gateway
```

#### Docker Compose
```yaml
version: '3.8'
services:
  gateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PIVOTA_API_BASE=${PIVOTA_API_BASE}
      - PIVOTA_API_KEY=${PIVOTA_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - MODE=production
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Option 3: Kubernetes Deployment

#### Deployment Manifest
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pivota-agent-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: pivota-agent-gateway
  template:
    metadata:
      labels:
        app: pivota-agent-gateway
    spec:
      containers:
      - name: gateway
        image: pivota-agent-gateway:latest
        ports:
        - containerPort: 3000
        env:
        - name: PIVOTA_API_BASE
          valueFrom:
            secretKeyRef:
              name: pivota-secrets
              key: api-base
        - name: PIVOTA_API_KEY
          valueFrom:
            secretKeyRef:
              name: pivota-secrets
              key: api-key
        livenessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

## Security Best Practices

### 1. Environment Variables
- **Never commit** `.env` files to version control
- Use platform-specific secret management:
  - Railway: Environment Variables UI
  - Kubernetes: Secrets
  - Docker: Secret files or environment files

### 2. API Key Management
- Rotate API keys regularly
- Use different keys for dev/staging/production
- Monitor key usage in Pivota console
- Implement key rotation without downtime

### 3. Network Security
- Always use HTTPS in production
- Implement rate limiting:
  ```javascript
  // Add to server.js
  const rateLimit = require("express-rate-limit");
  
  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100 // limit each IP to 100 requests per minute
  });
  
  app.use('/agent/shop/v1/invoke', limiter);
  ```

### 4. CORS Configuration
```javascript
// Add to server.js for browser-based access
const cors = require('cors');

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
```

## Monitoring and Logging

### 1. Structured Logging
The gateway uses Pino for structured logging. In production:
```javascript
// Configured in logger.js
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false // Disable colors in production
    }
  }
});
```

### 2. Key Metrics to Monitor
- **Request rate** by operation
- **Error rate** (4xx, 5xx responses)
- **Response time** P50, P95, P99
- **Upstream failures** by error type
- **Payment success rate**

### 3. Recommended Monitoring Stack
- **Logs**: CloudWatch, Datadog, or LogDNA
- **Metrics**: Prometheus + Grafana
- **Alerts**: PagerDuty or Opsgenie
- **APM**: New Relic or DataDog APM

### 4. Health Check Endpoint
```bash
# Basic health check
curl https://your-gateway.com/healthz

# Expected response
{"ok":true}
```

## Performance Optimization

### 1. Node.js Configuration
```javascript
// For production, set in start script
NODE_ENV=production
NODE_OPTIONS="--max-old-space-size=512"
```

### 2. Connection Pooling
Already implemented in the gateway for axios requests

### 3. Caching Strategy
Consider adding Redis for:
- Product search results (5-minute TTL)
- Order status (1-minute TTL)
- Static merchant data (1-hour TTL)

## Testing in Production

### 1. Smoke Tests
After deployment, run basic tests:
```bash
# Health check
curl https://your-gateway.com/healthz

# Test with mock operation (if enabled)
curl -X POST https://your-gateway.com/agent/shop/v1/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "find_products",
    "payload": {
      "search": {"query": "test", "city": "Shanghai"}
    }
  }'
```

### 2. Load Testing
Use tools like k6 or Apache JMeter:
```javascript
// k6 script example
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 }, // Ramp up
    { duration: '5m', target: 100 }, // Stay at 100
    { duration: '2m', target: 0 },   // Ramp down
  ],
};

export default function() {
  let response = http.get('https://your-gateway.com/healthz');
  check(response, {
    'status is 200': (r) => r.status === 200,
  });
}
```

## Rollback Strategy

### 1. Railway
- Use deployment history to rollback
- Pin specific commits for stable releases

### 2. Docker/K8s
- Tag images with version numbers
- Keep previous versions available
- Use blue-green deployments

## Troubleshooting

### Common Issues

1. **502 Bad Gateway**
   - Check PIVOTA_API_BASE is correct
   - Verify network connectivity
   - Check upstream service status

2. **401 Unauthorized**
   - Verify PIVOTA_API_KEY is set
   - Check key hasn't expired
   - Ensure Bearer prefix in headers

3. **Timeout Errors**
   - Increase timeout settings
   - Check upstream latency
   - Consider implementing retries

4. **Memory Issues**
   - Increase container memory limits
   - Check for memory leaks
   - Monitor heap usage

### Debug Mode
Enable detailed logging:
```bash
LOG_LEVEL=debug npm start
```

## Production Checklist

Before going live:
- [ ] All environment variables configured
- [ ] HTTPS enabled
- [ ] Health checks passing
- [ ] Error monitoring configured
- [ ] Rate limiting enabled
- [ ] Secrets properly managed
- [ ] Backup deployment ready
- [ ] Runbook documented
- [ ] On-call schedule set
- [ ] Test merchant account configured

## Support

For deployment issues:
1. Check logs for error messages
2. Verify environment variables
3. Test with curl commands
4. Review this deployment guide
5. Open issue on GitHub repository
