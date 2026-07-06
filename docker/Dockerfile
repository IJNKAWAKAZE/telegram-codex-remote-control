FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY .env.example ./

RUN npm run build

ENV NODE_ENV=production
ENV RELAY_HOME=/app
ENV CODEX_HOME=/app/data/codex-home

RUN mkdir -p /app/data/tmp /app/data/codex-home /workspace

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
