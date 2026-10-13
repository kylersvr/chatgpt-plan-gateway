# ChatGPT Plan Gateway: no dependencies to install, so the image is just Node and these files.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV NODE_ENV=production GATEWAY_DIR=/creds GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8787
USER node
CMD ["node", "bin/gateway.js"]
