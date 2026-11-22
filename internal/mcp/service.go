package mcp

import (
	"database/sql"
	"log/slog"
	"net/http"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
)

const iso8601Millis = "2006-01-02T15:04:05.000Z"

// ServiceOptions configures the MCP Connections & Streamable HTTP MCP server.
type ServiceOptions struct {
	DB               *sql.DB
	AuthService      *auth.Service
	BooksService     *books.Service
	BookshelfService *bookshelf.Service
	Logger           *slog.Logger
}

// Service implements /api/mcp-connections and /api/mcp.
type Service struct {
	db        *sql.DB
	auth      *auth.Service
	books     *books.Service
	bookshelf *bookshelf.Service
	logger    *slog.Logger
}

// NewService creates a new MCP Service.
func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		db:        opts.DB,
		auth:      opts.AuthService,
		books:     opts.BooksService,
		bookshelf: opts.BookshelfService,
		logger:    logger,
	}
}

// RegisterRoutes mounts /api/mcp-connections and /api/mcp without method prefixes
// so unsupported HTTP methods return exact 405 responses matching Nitro.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mcp-connections", s.handleConnections)
	mux.HandleFunc("/api/mcp", s.handleMCP)
}
