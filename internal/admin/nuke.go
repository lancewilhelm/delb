package admin

import (
	"net/http"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// GET /api/nuke mirrors server/api/nuke.get.ts.
func (s *Service) handleNuke(w http.ResponseWriter, r *http.Request) {
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.ErrorContext(r.Context(), "GET /api/nuke: session lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	s.logger.WarnContext(r.Context(), "nuke endpoint invoked", "actorUserId", swu.User.ID, "role", swu.User.Role)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
	})
}
