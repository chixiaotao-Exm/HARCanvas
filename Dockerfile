FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /har-canvas ./cmd/server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=server /har-canvas /app/har-canvas
COPY --from=web /src/web/dist /app/web/dist
USER app
EXPOSE 8090
ENTRYPOINT ["/app/har-canvas", "-addr", "0.0.0.0:8090", "-web", "/app/web/dist"]
