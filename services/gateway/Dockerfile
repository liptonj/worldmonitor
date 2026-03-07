FROM relay-base:latest

WORKDIR /app/gateway

COPY gateway/package.json ./
RUN npm install --omit=dev

COPY gateway/index.cjs ./

EXPOSE 3004
CMD ["node", "index.cjs"]
