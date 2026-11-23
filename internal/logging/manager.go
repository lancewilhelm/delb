package logging

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

// Options configures a logging Manager.
type Options struct {
	Level          slog.Level
	Format         Format
	Stdout         io.Writer
	Dir            string
	MaxFileBytes   int64
	MaxFiles       int
	MaxTotalBytes  int64
	MemoryCapacity int
}

// Manager coordinates Delb's structured multi-sink logger, runtime log level,
// in-memory ring buffer, rotating JSONL persistence, querying, and exports.
type Manager struct {
	levelVar *slog.LevelVar
	ring     *RingBuffer
	rotator  *FileRotator
	format   Format
	nextID   atomic.Uint64
	logger   *slog.Logger
}

// NewManager constructs a logging Manager with stdout + memory ring buffer +
// optional bounded rotating JSONL persistence (when opts.Dir is non-empty).
func NewManager(opts Options) (*Manager, error) {
	levelVar := &slog.LevelVar{}
	levelVar.Set(opts.Level)

	stdout := opts.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	format := opts.Format
	if format != FormatJSON {
		format = FormatText
	}

	var rotator *FileRotator
	if strings.TrimSpace(opts.Dir) != "" {
		r, err := NewFileRotator(RotatorOptions{
			Dir:           opts.Dir,
			MaxFileBytes:  opts.MaxFileBytes,
			MaxFiles:      opts.MaxFiles,
			MaxTotalBytes: opts.MaxTotalBytes,
		})
		if err != nil {
			return nil, err
		}
		rotator = r
	}

	m := &Manager{
		levelVar: levelVar,
		ring:     NewRingBuffer(opts.MemoryCapacity),
		rotator:  rotator,
		format:   format,
	}

	handlerOpts := &slog.HandlerOptions{
		Level:       levelVar,
		ReplaceAttr: RedactAttr,
	}
	var stdoutHandler slog.Handler
	if format == FormatJSON {
		stdoutHandler = slog.NewJSONHandler(stdout, handlerOpts)
	} else {
		stdoutHandler = slog.NewTextHandler(stdout, handlerOpts)
	}

	rootHandler := &fanoutHandler{
		manager: m,
		stdout:  stdoutHandler,
	}
	m.logger = slog.New(rootHandler)
	return m, nil
}

// Logger returns the root *slog.Logger backed by this Manager.
func (m *Manager) Logger() *slog.Logger {
	return m.logger
}

// Level returns the active minimum slog.Level.
func (m *Manager) Level() slog.Level {
	return m.levelVar.Level()
}

// LevelString returns the active minimum log level as a lowercase string.
func (m *Manager) LevelString() string {
	return LevelToString(m.levelVar.Level())
}

// SetLevel updates the runtime log level without restarting the server.
func (m *Manager) SetLevel(level slog.Level) {
	m.levelVar.Set(level)
}

// SetLevelString parses and applies a runtime log level string.
func (m *Manager) SetLevelString(raw string) (slog.Level, error) {
	lvl, err := ParseLevel(raw)
	if err != nil {
		return m.Level(), err
	}
	m.SetLevel(lvl)
	return lvl, nil
}

// StorageInfo returns current disk persistence and memory ring stats.
func (m *Manager) StorageInfo() StorageInfo {
	var info StorageInfo
	if m.rotator != nil {
		info = m.rotator.Stats()
	} else {
		info = StorageInfo{
			Enabled:       false,
			MaxFileBytes:  DefaultMaxFileBytes,
			MaxFiles:      DefaultMaxFiles,
			MaxTotalBytes: DefaultMaxTotalBytes,
		}
	}
	info.MemoryEntries = m.ring.Len()
	info.MemoryCapacity = m.ring.Capacity()
	return info
}

// Close closes the underlying file rotator, if enabled.
func (m *Manager) Close() error {
	if m.rotator != nil {
		return m.rotator.Close()
	}
	return nil
}

func (m *Manager) allEntries() ([]Entry, error) {
	if m.rotator != nil {
		entries, err := m.rotator.ReadAll()
		if err == nil && (len(entries) > 0 || m.ring.Len() == 0) {
			return entries, nil
		}
	}
	return m.ring.Snapshot(), nil
}

// Query filters, sorts, and paginates stored log entries.
func (m *Manager) Query(opts QueryOptions) (QueryResult, error) {
	all, err := m.allEntries()
	if err != nil {
		return QueryResult{}, err
	}

	compSet := make(map[string]struct{})
	matched := make([]Entry, 0, len(all))
	for _, entry := range all {
		if entry.Component != "" {
			compSet[entry.Component] = struct{}{}
		}
		if matchesQuery(entry, opts) {
			matched = append(matched, entry)
		}
	}

	components := make([]string, 0, len(compSet))
	for c := range compSet {
		components = append(components, c)
	}
	sort.Strings(components)

	order := strings.ToLower(strings.TrimSpace(opts.Order))
	if order != "asc" {
		order = "desc"
		slices.Reverse(matched)
	}

	limit := opts.Limit
	if limit <= 0 {
		limit = DefaultQueryLimit
	}
	if limit > MaxQueryLimit {
		limit = MaxQueryLimit
	}
	offset := opts.Offset
	if offset < 0 {
		offset = 0
	}

	total := len(matched)
	var page []Entry
	if offset < total {
		end := offset + limit
		if end > total {
			end = total
		}
		page = matched[offset:end]
	} else {
		page = []Entry{}
	}

	return QueryResult{
		Entries:    page,
		Total:      total,
		HasMore:    offset+len(page) < total,
		Limit:      limit,
		Offset:     offset,
		Components: components,
		Level:      m.LevelString(),
		Storage:    m.StorageInfo(),
	}, nil
}

// Export writes logs in either JSONL or human-readable plain text format.
func (m *Manager) Export(w io.Writer, format ExportFormat, opts QueryOptions, scope ExportScope) error {
	all, err := m.allEntries()
	if err != nil {
		return err
	}

	var entries []Entry
	if scope == ExportScopeFiltered {
		entries = make([]Entry, 0, len(all))
		for _, entry := range all {
			if matchesQuery(entry, opts) {
				entries = append(entries, entry)
			}
		}
	} else {
		entries = all
	}

	if strings.EqualFold(strings.TrimSpace(opts.Order), "desc") {
		cp := make([]Entry, len(entries))
		copy(cp, entries)
		slices.Reverse(cp)
		entries = cp
	}

	if format == ExportFormatJSONL {
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		for _, entry := range entries {
			if err := enc.Encode(entry); err != nil {
				return err
			}
		}
		return nil
	}

	for _, entry := range entries {
		if _, err := io.WriteString(w, FormatEntryText(entry)+"\n"); err != nil {
			return err
		}
	}
	return nil
}

// FormatEntryText formats a structured Entry as a single readable log line.
func FormatEntryText(entry Entry) string {
	var b strings.Builder
	b.WriteString(entry.Time.UTC().Format("2006-01-02T15:04:05.000Z"))
	b.WriteByte(' ')
	lvl := strings.ToUpper(entry.Level)
	if len(lvl) < 5 {
		lvl += strings.Repeat(" ", 5-len(lvl))
	}
	b.WriteString(lvl)
	if entry.Component != "" {
		b.WriteString(" [")
		b.WriteString(entry.Component)
		b.WriteByte(']')
	}
	if entry.RequestID != "" {
		b.WriteString(" [req:")
		b.WriteString(entry.RequestID)
		b.WriteByte(']')
	}
	b.WriteByte(' ')
	b.WriteString(entry.Message)

	if len(entry.Attrs) > 0 {
		keys := make([]string, 0, len(entry.Attrs))
		for k := range entry.Attrs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteByte(' ')
			b.WriteString(k)
			b.WriteByte('=')
			b.WriteString(formatAttrTextValue(entry.Attrs[k]))
		}
	}
	return b.String()
}

func formatAttrTextValue(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		if strings.ContainsAny(x, " \t\n\r=\"") || x == "" {
			return fmt.Sprintf("%q", x)
		}
		return x
	case bool, int, int64, uint64, float64:
		return fmt.Sprintf("%v", x)
	default:
		raw, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprintf("%q", fmt.Sprint(x))
		}
		return string(raw)
	}
}

func matchesQuery(entry Entry, opts QueryOptions) bool {
	if opts.Level != "" {
		want := strings.ToLower(strings.TrimSpace(opts.Level))
		if want == "warning" {
			want = "warn"
		}
		if strings.ToLower(entry.Level) != want {
			return false
		}
	}
	if opts.MinLevel != "" {
		minRank := levelRank(opts.MinLevel)
		if minRank >= 0 && levelRank(entry.Level) < minRank {
			return false
		}
	}
	if opts.Component != "" {
		if !strings.EqualFold(entry.Component, strings.TrimSpace(opts.Component)) {
			return false
		}
	}
	if opts.RequestID != "" {
		needle := strings.ToLower(strings.TrimSpace(opts.RequestID))
		if !strings.Contains(strings.ToLower(entry.RequestID), needle) {
			return false
		}
	}
	if !opts.Since.IsZero() && entry.Time.Before(opts.Since) {
		return false
	}
	if !opts.Until.IsZero() && entry.Time.After(opts.Until) {
		return false
	}
	if q := strings.ToLower(strings.TrimSpace(opts.Query)); q != "" {
		if !entryMatchesText(entry, q) {
			return false
		}
	}
	return true
}

func entryMatchesText(entry Entry, lowerNeedle string) bool {
	if strings.Contains(strings.ToLower(entry.Message), lowerNeedle) ||
		strings.Contains(strings.ToLower(entry.Component), lowerNeedle) ||
		strings.Contains(strings.ToLower(entry.RequestID), lowerNeedle) ||
		strings.Contains(strings.ToLower(entry.Level), lowerNeedle) {
		return true
	}
	if len(entry.Attrs) > 0 {
		raw, err := json.Marshal(entry.Attrs)
		if err == nil && strings.Contains(strings.ToLower(string(raw)), lowerNeedle) {
			return true
		}
	}
	return false
}

// scopedAttr preserves the group nesting in effect when WithAttrs was called.
type scopedAttr struct {
	groups []string
	attr   slog.Attr
}

type fanoutHandler struct {
	manager *Manager
	stdout  slog.Handler
	attrs   []scopedAttr
	groups  []string
}

func (h *fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= h.manager.levelVar.Level()
}

func (h *fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	redacted := make([]slog.Attr, 0, len(attrs))
	nextScoped := make([]scopedAttr, len(h.attrs), len(h.attrs)+len(attrs))
	copy(nextScoped, h.attrs)

	groupsCopy := append([]string(nil), h.groups...)
	for _, a := range attrs {
		ra := redactAttr(a)
		redacted = append(redacted, ra)
		nextScoped = append(nextScoped, scopedAttr{
			groups: groupsCopy,
			attr:   ra,
		})
	}

	return &fanoutHandler{
		manager: h.manager,
		stdout:  h.stdout.WithAttrs(redacted),
		attrs:   nextScoped,
		groups:  groupsCopy,
	}
}

func (h *fanoutHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	nextGroups := make([]string, len(h.groups)+1)
	copy(nextGroups, h.groups)
	nextGroups[len(h.groups)] = name

	nextScoped := make([]scopedAttr, len(h.attrs))
	copy(nextScoped, h.attrs)

	return &fanoutHandler{
		manager: h.manager,
		stdout:  h.stdout.WithGroup(name),
		attrs:   nextScoped,
		groups:  nextGroups,
	}
}

func (h *fanoutHandler) Handle(ctx context.Context, r slog.Record) error {
	if !h.Enabled(ctx, r.Level) {
		return nil
	}

	ts := r.Time.UTC()
	if ts.IsZero() {
		ts = time.Now().UTC()
	}

	msg := SanitizeString(r.Message)
	entryAttrs := make(map[string]any)
	var component string
	var requestID string

	recordCopy := slog.NewRecord(ts, r.Level, msg, r.PC)

	applyAttr := func(groups []string, a slog.Attr) {
		if a.Equal(slog.Attr{}) {
			return
		}
		if len(groups) == 0 {
			switch a.Key {
			case "component":
				if a.Value.Kind() == slog.KindString {
					component = a.Value.String()
					return
				}
			case "requestId":
				if a.Value.Kind() == slog.KindString {
					requestID = a.Value.String()
					return
				}
			}
		}
		insertNestedAttr(entryAttrs, groups, a)
	}

	for _, sa := range h.attrs {
		applyAttr(sa.groups, sa.attr)
	}

	r.Attrs(func(a slog.Attr) bool {
		ra := redactAttr(a)
		recordCopy.AddAttrs(ra)
		applyAttr(h.groups, ra)
		return true
	})

	if requestID == "" {
		if ctxReqID := RequestIDFromContext(ctx); ctxReqID != "" {
			requestID = ctxReqID
			// Attach to stdout output only when not inside a group, or as top-level attr.
			if len(h.groups) == 0 {
				recordCopy.AddAttrs(slog.String("requestId", ctxReqID))
			}
		}
	}

	_ = h.stdout.Handle(ctx, recordCopy)

	entry := Entry{
		ID:        h.manager.nextID.Add(1),
		Time:      ts,
		Level:     LevelToString(r.Level),
		Message:   msg,
		Component: component,
		RequestID: requestID,
	}
	if len(entryAttrs) > 0 {
		entry.Attrs = entryAttrs
	}

	h.manager.ring.Append(entry)
	if h.manager.rotator != nil {
		if raw, err := json.Marshal(entry); err == nil {
			_ = h.manager.rotator.WriteLine(raw)
		}
	}
	return nil
}

func insertNestedAttr(dst map[string]any, groups []string, a slog.Attr) {
	resolved := a.Value.Resolve()
	if resolved.Kind() == slog.KindGroup {
		children := resolved.Group()
		if len(children) == 0 {
			return
		}
		nextGroups := groups
		if a.Key != "" {
			nextGroups = append(append([]string(nil), groups...), a.Key)
		}
		for _, child := range children {
			insertNestedAttr(dst, nextGroups, child)
		}
		return
	}
	if a.Key == "" {
		return
	}

	target := dst
	for _, g := range groups {
		sub, ok := target[g].(map[string]any)
		if !ok {
			sub = make(map[string]any)
			target[g] = sub
		}
		target = sub
	}
	target[a.Key] = slogValueToJSON(resolved)
}

func slogValueToJSON(v slog.Value) any {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindInt64:
		return v.Int64()
	case slog.KindUint64:
		return v.Uint64()
	case slog.KindFloat64:
		return v.Float64()
	case slog.KindBool:
		return v.Bool()
	case slog.KindDuration:
		return v.Duration().String()
	case slog.KindTime:
		return v.Time().UTC().Format(time.RFC3339Nano)
	case slog.KindGroup:
		out := make(map[string]any)
		for _, a := range v.Group() {
			insertNestedAttr(out, nil, a)
		}
		return out
	case slog.KindAny:
		val := v.Any()
		if err, ok := val.(error); ok {
			return SanitizeString(err.Error())
		}
		return val
	default:
		return v.String()
	}
}
