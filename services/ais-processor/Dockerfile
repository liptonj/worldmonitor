FROM relay-base:latest

WORKDIR /app/ais-processor

COPY ais-processor/package.json ./
RUN npm install --omit=dev

COPY ais-processor/index.cjs ./

CMD ["node", "index.cjs"]
