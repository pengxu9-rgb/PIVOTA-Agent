# Use glibc-based Node image (onnxruntime-node is not compatible with Alpine musl).
FROM node:20-bookworm-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies. Railway CLI uploads can occasionally miss
# package-lock.json, so keep a deterministic ci path when present and fall
# back to a production-only install otherwise.
RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy application files
COPY . .

# Stamp the commit INTO the image, so what /health reports is a property of the code rather
# than a claim about it. Until now the only source was the PIVOTA_COMMIT_SHA env var set at
# deploy time, and `gcloud run deploy --image X` with no env flag INHERITS the previous
# revision's environment: on 2026-08-25 a revision ran the `17e7cfa8` image while /health kept
# reporting `6aa49526db95`, and `gateway-prod-drift.yml` - whose entire job is comparing that
# value to main - reasoned about the wrong commit. A stale stamp that happens to MATCH main is
# worse still: the alarm goes green over undeployed code.
#
# A file, not an ENV: `gcloud run deploy --set-env-vars/--update-env-vars` can override an
# image ENV, so the guarantee would hold only until someone set that name. Nothing in a Cloud
# Run deploy can rewrite a file inside the image.
#
# Placed AFTER `COPY . .` on purpose - the copy already invalidates the cache on any source
# change, so the arg costs no extra layer churn. Empty when built without the arg (a local
# `docker build`), and src/config/platform.js falls back to the env chain.
ARG COMMIT_SHA=""
RUN printf '%s' "$COMMIT_SHA" > /app/.image_commit_sha

# Change ownership and switch to built-in non-root user.
RUN chown -R node:node /app
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); })"

# Start application
CMD ["node", "src/server.js"]
