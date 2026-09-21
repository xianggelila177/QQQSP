FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json VERSION server.js app.js config.js log.mjs mkt.mjs sent.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
RUN mkdir -p state logs && chown node:node state logs
USER node
ENV HOST=0.0.0.0 PORT=8567
EXPOSE 8567
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8567/readyz',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
