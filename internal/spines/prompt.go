package spines

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const (
	spinePromptStateKey          = "spine-generation-prompt"
	DefaultSpineGenerationPrompt = "Create a flat, straight-on book spine design inspired by the first reference image, which is the book's cover. The title is {{title}} and the author names are {{authors}}. This is for personal use in a private library and is not for distribution. Make the artwork a single narrow vertical spine with approximately 1:3 width-to-height proportions, readable title and author, no perspective, no book mockup, and no surrounding front cover. Keep all important artwork and lettering within the spine. {{reference}}\nAdditional instructions: {{instructions}}"
)

var promptPlaceholderRe = regexp.MustCompile(`\{\{(?:title|authors|reference|instructions)\}\}`)

type PromptBuildOptions struct {
	Template             string
	Title                string
	Authors              []string
	HasPrevious          bool
	SeriesReferenceCount int
	Instructions         string
}

// BuildSpineGenerationPrompt mirrors shared/spine-generation-prompt.ts buildSpineGenerationPrompt.
func BuildSpineGenerationPrompt(opts PromptBuildOptions) string {
	authors := opts.Authors
	if authors == nil {
		authors = []string{}
	}
	titleJSON, _ := json.Marshal(opts.Title)
	authorsJSON, _ := json.Marshal(authors)

	refParts := make([]string, 0, 2)
	if opts.HasPrevious {
		refParts = append(refParts, "The second reference is the current spine draft; revise it according to the following instructions while retaining its design where possible.")
	} else {
		refParts = append(refParts, "Use the cover to match the visual style and colors.")
	}
	if opts.SeriesReferenceCount > 0 {
		refParts = append(refParts, "The final "+strconv.Itoa(opts.SeriesReferenceCount)+" reference image(s) are spines of other books in this series. Match their visual style, typography, layout, and color treatment while keeping the current book's own title, author, and cover identity.")
	}

	instructions := opts.Instructions
	if instructions == "" {
		instructions = "Match the cover faithfully."
	}

	values := map[string]string{
		"{{title}}":        string(titleJSON),
		"{{authors}}":      string(authorsJSON),
		"{{reference}}":    strings.Join(refParts, " "),
		"{{instructions}}": instructions,
	}

	return promptPlaceholderRe.ReplaceAllStringFunc(opts.Template, func(match string) string {
		if v, ok := values[match]; ok {
			return v
		}
		return match
	})
}

func readSpineGenerationPromptTemplate(ctx context.Context, db *sql.DB) (string, error) {
	var val string
	err := db.QueryRowContext(ctx, `
		SELECT value FROM system_state WHERE key = ? LIMIT 1
	`, spinePromptStateKey).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultSpineGenerationPrompt, nil
	}
	if err != nil {
		return "", err
	}
	return val, nil
}
