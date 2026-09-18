# Production Dockerfile for GridWise LLM (Root Context)
# BUP CSE Fest 2026 — Smart Campus Energy Optimization
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info

# Install production dependencies
COPY gridwise-llm/package*.json ./
RUN npm ci --omit=dev

# Copy application source and benchmark files
COPY gridwise-llm/src/ ./src/
COPY gridwise-llm/test/ ./test/
COPY BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json ../BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json

# Expose application port
EXPOSE 3000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the optimization service
CMD ["npm", "start"]

