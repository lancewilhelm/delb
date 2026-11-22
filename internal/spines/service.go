package spines

import (
	"database/sql"
	"log/slog"
	"net/http"
	"path/filepath"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type ServiceOptions struct {
	DB           *sql.DB
	AuthService  *auth.Service
	AuthSecret   string
	LibraryDir   string
	CodexAuthURL string
	CodexAPIURL  string
	HTTPClient   *http.Client
	Logger       *slog.Logger
}

type Service struct {
	db         *sql.DB
	auth       *auth.Service
	libraryDir string
	codex      *CodexManager
	logger     *slog.Logger
}

func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	libraryDir := opts.LibraryDir
	if libraryDir == "" {
		libraryDir = "library"
	}
	if absLib, err := filepath.Abs(libraryDir); err == nil {
		libraryDir = absLib
	}
	return &Service{
		db:         opts.DB,
		auth:       opts.AuthService,
		libraryDir: libraryDir,
		codex:      NewCodexManager(opts.DB, opts.AuthSecret, opts.CodexAuthURL, opts.CodexAPIURL, opts.HTTPClient),
		logger:     logger,
	}
}

// RegisterRoutes mounts all Phase 2C spine artwork, spine generation, and
// ChatGPT image admin routes onto mux.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	reqSess := func(h http.HandlerFunc) http.HandlerFunc {
		return httpapi.RequireSessionFunc(s.auth, s.logger, h)
	}

	// Book spine artwork (GET, POST, DELETE, else 405)
	mux.HandleFunc("/api/books/{id}/spine", reqSess(s.handleBookSpine))

	// Spine generation routes
	mux.HandleFunc("POST /api/books/{id}/spine-generate", s.handleSpineGenerate)
	mux.HandleFunc("/api/books/{id}/spine-generate/connection", s.handleSpineGenerateConnection)
	mux.HandleFunc("GET /api/books/{id}/spine-generate/series-references", reqSess(s.handleSpineGenerateSeriesReferences))

	// Admin ChatGPT image connection (GET, POST, DELETE, else 405)
	mux.HandleFunc("/api/settings/admin/chatgpt-image", s.handleAdminChatGPTImage)
}

func (s *Service) writeErr(w http.ResponseWriter, logMsg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
