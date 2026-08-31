FROM node:20-alpine

WORKDIR /usr/src/app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Run as non-root (satisfies runAsNonRoot enforced by the CodeNOW helm chart)
# Use a numeric UID so Kubernetes can verify the user is non-root.
USER 1000

# Service port exposed to CodeNOW (see .codenow.yaml runtime.port)
ENV PORT=3000

EXPOSE 3000
CMD [ "node", "server.js" ]
