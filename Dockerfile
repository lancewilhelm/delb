# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.22.3
ARG GO_VERSION=1.27

# -------------------------------
# Stage 1: Build Vue 3 + Vite SPA
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS web-build
WORKDIR /src

# Install the pinned native pnpm once.
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")" \
  && pnpm --version

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json ./
COPY app ./app
COPY shared ./shared
COPY public ./public

ARG APP_VERSION=unknown
ARG NUXT_PUBLIC_APP_VERSION=""
RUN VERSION="${APP_VERSION}" && \
  if [ "${VERSION}" = "unknown" ] && [ -n "${NUXT_PUBLIC_APP_VERSION}" ]; then \
    VERSION="${NUXT_PUBLIC_APP_VERSION}"; \
  fi && \
  VITE_APP_VERSION="${VERSION}" pnpm build:web

# -------------------------------
# Stage 2: Compile static Go binary with embedded SPA and SQL migrations
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS go-build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY embed_migrations.go embed_web.go ./
COPY .drizzle/migrations ./.drizzle/migrations
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web-build /src/dist ./dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
  go build -trimpath -ldflags="-s -w" -o /out/delb ./cmd/delb

RUN mkdir -p /rootfs/etc /rootfs/app/data /rootfs/app/library /rootfs/app/dropbox /rootfs/tmp && \
  printf 'delb:x:1001:1001:Delb:/app:/sbin/nologin\n' > /rootfs/etc/passwd && \
  printf 'delb:x:1001:\n' > /rootfs/etc/group && \
  chown -R 1001:1001 /rootfs/app && \
  chmod 1777 /rootfs/tmp

# -------------------------------
# Stage 3: Minimal scratch runtime
FROM scratch

COPY --from=go-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=go-build /rootfs/etc/passwd /etc/passwd
COPY --from=go-build /rootfs/etc/group /etc/group
COPY --from=go-build /rootfs/app /app
COPY --from=go-build /rootfs/tmp /tmp
COPY --from=go-build /out/delb /app/delb

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

VOLUME ["/app/data"]
USER 1001:1001
EXPOSE 3000

ENTRYPOINT ["/app/delb"]
