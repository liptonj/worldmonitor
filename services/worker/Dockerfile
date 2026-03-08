ARG BASE_IMAGE=sliptronic/worldrelay_base:latest
FROM ${BASE_IMAGE}

WORKDIR /app/worker

COPY worker/package.json ./
RUN npm install --omit=dev

COPY worker/index.cjs ./

CMD ["node", "index.cjs"]
