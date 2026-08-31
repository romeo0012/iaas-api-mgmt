FROM node:20-alpine

WORKDIR /usr/src/app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Service port exposed to CodeNOW (see .codenow.yaml runtime.port)
ENV PORT=3000

EXPOSE 3000
CMD [ "node", "server.js" ]
