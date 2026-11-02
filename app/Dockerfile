FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js seed.js ./
COPY src ./src
COPY profiles ./profiles
COPY site ./site

# Data: set DATABASE_URL (Postgres) or mount a volume for embedded PGlite.
ENV PORT=3000
EXPOSE 3000

# seed.js is idempotent — safe on every boot, no-op once data exists.
CMD ["node", "server.js"]
