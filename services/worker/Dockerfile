FROM relay-base:latest

WORKDIR /app/worker

COPY worker/package.json ./
RUN npm install --omit=dev

COPY worker/index.cjs ./

CMD ["node", "index.cjs"]
