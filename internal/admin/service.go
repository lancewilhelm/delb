package admin

import (
	"database/sql"
	"log/slog"
	"net/http"
	"path/filepath"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const iso8601Millis = "2006-01-02T15:04:05.000Z"

// ServiceOptions configures the Admin Operations service (health, Calibre import/rescan, nuke).
type ServiceOptions struct {
	DB          *sql.DB
	AuthService *auth.Service
	LibraryDir  string
	CalibreDir  string
	Logger      *slog.Logger
}

// Service implements Phase 2D admin HTTP routes.
type Service struct {
	db         *sql.DB
	auth       *auth.Service
	libraryDir string
	calibreDir string
	logger     *slog.Logger
}

// NewService constructs an admin Service.
func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	libraryDir := opts.LibraryDir
	if libraryDir == "" {
		libraryDir = "library"
	}
	if abs, err := filepath.Abs(libraryDir); err == nil {
		libraryDir = abs
	}
	calibreDir := opts.CalibreDir
	if calibreDir == "" {
		calibreDir = "calibre"
	}
	if abs, err := filepath.Abs(calibreDir); err == nil {
		calibreDir = abs
	}
	return &Service{
		db:         opts.DB,
		auth:       opts.AuthService,
		libraryDir: libraryDir,
		calibreDir: calibreDir,
		logger:     logger,
	}
}

// RegisterRoutes mounts the admin routes onto mux.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/settings/admin/health", s.handleAdminHealth)
	mux.HandleFunc("POST /api/settings/admin/calibre", s.handleAdminCalibre)
	mux.HandleFunc("GET /api/nuke", s.handleNuke)
}

func (s *Service) requireAdminOrOwner(w http.ResponseWriter, r *http.Request) (*auth.SessionWithUser, bool) {
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("session lookup failed", "path", r.URL.Path, "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return nil, false
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return nil, false
	}
	if swu.User.Role != "admin" && swu.User.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Forbidden")
		return nil, false
	}
	return swu, true
}

func (s *Service) writeErr(w http.ResponseWriter, logMsg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
