FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

USER node

ENV NODE_ENV=production
ENV PORT=10000
ENV NODE_OPTIONS="--max-old-space-size=384"

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "src/index.js"]
