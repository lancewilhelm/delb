package delb

import "embed"

// WebFS embeds the compiled Vite SPA from dist/. The tracked dist/.gitkeep
// file ensures `go test ./...` and `go vet ./...` succeed even before
// `pnpm build:web` populates dist/.
//
//go:embed all:dist
var WebFS embed.FS
