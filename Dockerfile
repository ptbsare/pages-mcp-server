FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (for layer caching)
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev) so we can build
RUN npm ci --ignore-scripts

# Copy source
COPY . .

# Build TypeScript
RUN npx tsc

# Remove dev dependencies to reduce image size
RUN npm prune --production

# ─── Production stage ────────────────────────────────────
FROM node:20-alpine

# Create non-root user
RUN addgroup -S pages-mcp && \
    adduser -S pages-mcp -G pages-mcp

WORKDIR /app

# Copy built assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/public ./server/public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Create data directories
RUN mkdir -p /data/storage /data/db && \
    chown -R pages-mcp:pages-mcp /data

# Environment defaults
ENV PORT=3000
ENV DOMAIN=http://localhost:3000
ENV ADMIN_USERNAME=admin
ENV ADMIN_PASSWORD=admin123
ENV DB_PATH=/data/db/pages.db
ENV STORAGE_PATH=/data/storage

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Run as non-root
USER pages-mcp

CMD ["node", "dist/server/index.js"]
