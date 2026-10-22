FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data TRUST_PROXY=1 PORT=4000
# Run as the unprivileged "node" user (uid 1000), not root. The data folder must be writable by it:
# a new volume gets these permissions; for an existing volume run once:  chown -R 1000:1000 /data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
CMD ["node", "server.js"]
