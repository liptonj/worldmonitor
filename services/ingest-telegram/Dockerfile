FROM relay-base:latest

WORKDIR /app/ingest-telegram

COPY ingest-telegram/package.json ./
RUN npm install --omit=dev

COPY ingest-telegram/index.cjs ./

CMD ["node", "index.cjs"]
