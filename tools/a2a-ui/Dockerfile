# Build a2a-ui from GitHub for local A2A testing
# This clones the latest a2a-community/a2a-ui and builds with Phoenix URL baked in

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/a2a-community/a2a-ui.git .
RUN npm ci
ENV NEXT_PUBLIC_ARIZE_PHOENIX_URL=http://localhost:6006
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next .next
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json .
COPY --from=builder /app/next.config* .
COPY --from=builder /app/public public
EXPOSE 3000
CMD ["npm", "start"]
