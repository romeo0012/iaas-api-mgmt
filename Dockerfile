FROM node:20-alpine

WORKDIR /usr/src/app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Run as non-root (satisfies runAsNonRoot enforced by the CodeNOW helm chart)
RUN chown -R node:node /usr/src/app
USER node

# Service port exposed to CodeNOW (see .codenow.yaml runtime.port)
ENV PORT=3000

EXPOSE 3000
CMD [ "node", "server.js" ]
