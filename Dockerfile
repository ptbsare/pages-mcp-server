FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Create data directories
RUN mkdir -p /data/storage /data/db

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

# Run server
CMD ["node", "dist/server/index.js"]
