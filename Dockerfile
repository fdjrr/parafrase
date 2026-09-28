FROM node:22-alpine

WORKDIR /app
COPY server.js index.html ./

ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

CMD ["node", "server.js"]
