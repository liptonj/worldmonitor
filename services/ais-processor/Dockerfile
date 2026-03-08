ARG BASE_IMAGE=sliptronic/worldrelay_base:latest
FROM ${BASE_IMAGE}

WORKDIR /app/ais-processor

COPY ais-processor/package.json ./
RUN npm install --omit=dev

COPY ais-processor/index.cjs ./

CMD ["node", "index.cjs"]
