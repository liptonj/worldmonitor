ARG BASE_IMAGE=sliptronic/worldrelay_base:latest
FROM ${BASE_IMAGE}

WORKDIR /app/gateway

COPY gateway/package.json ./
RUN npm install --omit=dev

COPY gateway/index.cjs ./
COPY gateway/channel-keys.json ./

EXPOSE 3004
CMD ["node", "index.cjs"]
