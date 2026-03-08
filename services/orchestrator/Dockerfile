ARG BASE_IMAGE=sliptronic/worldrelay_base:latest
FROM ${BASE_IMAGE}

WORKDIR /app/orchestrator

COPY orchestrator/package.json ./
RUN npm install --omit=dev

COPY orchestrator/index.cjs ./

CMD ["node", "index.cjs"]
