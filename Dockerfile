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
