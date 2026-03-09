ARG BASE_IMAGE=sliptronic/worldrelay_base:latest
FROM ${BASE_IMAGE}

WORKDIR /app/ingest-telegram

COPY ingest-telegram/package.json ingest-telegram/package-lock.json ./
RUN npm ci --omit=dev

COPY ingest-telegram/index.cjs ./

CMD ["node", "index.cjs"]
