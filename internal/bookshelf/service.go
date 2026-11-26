package bookshelf

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"log/slog"
	"net/http"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type ServiceOptions struct {
	DB          *sql.DB
	AuthService *auth.Service
	TokenSecret string
	Logger      *slog.Logger
}

type Service struct {
	db          *sql.DB
	auth        *auth.Service
	tokenSecret string
	logger      *slog.Logger
}

func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	secret := opts.TokenSecret
	if secret == "" {
		buf := make([]byte, 32)
		_, _ = rand.Read(buf)
		secret = hex.EncodeToString(buf)
	}
	return &Service{
		db:          opts.DB,
		auth:        opts.AuthService,
		tokenSecret: secret,
		logger:      logger,
	}
}

const maxBookshelfBodyBytes int64 = 16 * 1024 * 1024

// RegisterRoutes mounts bookshelf, personal shelf, book-shelf
// membership, and bookshelf picture routes onto mux.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	reqSess := func(h http.HandlerFunc) http.HandlerFunc {
		return httpapi.RequireSessionFunc(s.auth, s.logger, h)
	}

	// Collection bookshelves
	mux.HandleFunc("GET /api/collections/{id}/bookshelf", reqSess(s.handleGetCollectionBookshelf))
	mux.HandleFunc("PUT /api/collections/{id}/bookshelf", reqSess(s.handlePutCollectionBookshelf))

	// Personal shelves & book-shelf membership
	mux.HandleFunc("GET /api/shelves", reqSess(s.handleListShelves))
	mux.HandleFunc("POST /api/shelves", reqSess(s.handleCreateShelf))
	mux.HandleFunc("GET /api/shelves/{id}", reqSess(s.handleGetShelf))
	mux.HandleFunc("PUT /api/shelves/{id}", reqSess(s.handlePutShelf))
	mux.HandleFunc("PATCH /api/shelves/{id}", reqSess(s.handlePatchShelf))
	mux.HandleFunc("DELETE /api/shelves/{id}", reqSess(s.handleDeleteShelf))
	mux.HandleFunc("POST /api/shelves/{id}/books", reqSess(s.handlePostShelfBooks))
	mux.HandleFunc("GET /api/books/{id}/shelves", reqSess(s.handleGetBookShelves))

	// Bookshelf pictures (handle all methods so unsupported methods return 405)
	mux.HandleFunc("/api/bookshelf-pictures/{scope}/{id}", reqSess(s.handleBookshelfPictures))
}

func (s *Service) writeErr(w http.ResponseWriter, logMsg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
