FROM relay-base:latest

WORKDIR /app/ai-engine

COPY ai-engine/package.json ./
RUN npm install --omit=dev

COPY ai-engine/generators/ ./generators/
COPY ai-engine/index.cjs ./

CMD ["node", "index.cjs"]
