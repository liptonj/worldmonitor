FROM relay-base:latest

WORKDIR /app/orchestrator

COPY orchestrator/package.json ./
RUN npm install --omit=dev

COPY orchestrator/index.cjs ./

CMD ["node", "index.cjs"]
