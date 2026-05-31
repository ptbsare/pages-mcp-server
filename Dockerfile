FROM node:20-alpine

WORKDIR /app

# Copy package files first (for layer caching)
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev) so we can build
RUN npm ci --ignore-scripts

# Copy source (including dist/ if pre-built)
COPY . .

# Build TypeScript
RUN npx tsc

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create data directories and non-root user
RUN mkdir -p /data/storage /data/db && \
    addgroup -S pages-mcp && \
    adduser -S pages-mcp -G pages-mcp

# Environment defaults
ENV PORT=3000
ENV DOMAIN=http://localhost:3000
ENV ADMIN_USERNAME=admin
ENV ADMIN_PASSWORD=admin123
ENV AUTH_TOKEN=my-secret-token
ENV DB_PATH=/data/db/pages.db
ENV STORAGE_PATH=/data/storage

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Switch to non-root user
USER pages-mcp

# Run server
CMD ["node", "dist/server/index.js"]
