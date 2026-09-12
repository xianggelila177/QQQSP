FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV HOST=0.0.0.0 PORT=8567
RUN mkdir -p /app/state /app/logs && chown node:node /app/state /app/logs
USER node
EXPOSE 8567
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "ops/healthcheck.mjs"]
CMD ["node", "server.js"]
