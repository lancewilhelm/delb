package dropbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/storage"
)

func timestampForFilename(d time.Time) string {
	return fmt.Sprintf("%04d%02d%02d-%02d%02d%02d",
		d.Year(), int(d.Month()), d.Day(),
		d.Hour(), d.Minute(), d.Second(),
	)
}

func moveToFailed(failedDirAbs, fileAbs, originalFilename, reason string, now time.Time) bool {
	if err := os.MkdirAll(failedDirAbs, 0o755); err != nil {
		return false
	}
	ext := filepath.Ext(originalFilename)
	base := strings.TrimSuffix(filepath.Base(originalFilename), ext)
	failedName := fmt.Sprintf("%s.%s.%s%s", base, timestampForFilename(now), uuid.NewString(), ext)
	dest := filepath.Join(failedDirAbs, failedName)

	if err := storage.CopyVerifiedExclusive(fileAbs, dest); err != nil {
		// Keep the claim if the failed destination cannot be safely created.
		return false
	}
	if err := os.Remove(fileAbs); err != nil {
		return false
	}
	_ = os.WriteFile(dest+".error.txt", []byte(reason+"\n"), 0o644)
	return true
}
