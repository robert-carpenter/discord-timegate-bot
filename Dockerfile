# Use a lightweight Node 20 base image
FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first (better cache)
COPY package*.json ./
RUN npm install --only=production

# Copy source
COPY src ./src
COPY config.example.json ./
COPY .env.example ./

# Runtime config/state is provided via env/config.json; data directory is persisted externally if desired.
CMD ["npm", "start"]
