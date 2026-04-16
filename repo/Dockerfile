FROM node:20-alpine

WORKDIR /app

# Install build dependencies for argon2
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

# Create data directory
RUN mkdir -p /app/data/logs

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
