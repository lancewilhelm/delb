package books

import "testing"

func TestInclusiveDaySpan(t *testing.T) {
	cases := []struct {
		start, finish string
		want          int
	}{
		{"2026-11-03", "2026-11-11", 9},
		{"2026-11-03", "2026-11-03", 1},
		{"2024-02-28", "2024-03-01", 3}, // leap day
		{"2026-03-07", "2026-03-09", 3}, // spans a DST change in many zones
		{"2026-11-11", "2026-11-03", 0},
		{"", "2026-11-03", 0},
		{"2026-11-03", "not-a-date", 0},
	}
	for _, c := range cases {
		if got := inclusiveDaySpan(c.start, c.finish); got != c.want {
			t.Errorf("inclusiveDaySpan(%q, %q) = %d, want %d", c.start, c.finish, got, c.want)
		}
	}
}

func TestBuildFinishProgressSeries(t *testing.T) {
	pages := int64(200)
	logs := []finishLog{
		{Date: "2026-10-30", Percent: 40}, // before the window: ignored
		{Date: "2026-11-01", Percent: 10},
		{Date: "2026-11-01", Percent: 25}, // best checkpoint of the day wins
		{Date: "2026-11-03", Percent: 20}, // a lower checkpoint does not go back
		{Date: "2026-11-04", Percent: 100},
		{Date: "2026-11-09", Percent: 100}, // after the window: ignored
	}
	s := buildFinishProgressSeries("2026-11-01", "2026-11-04", logs, &pages)
	if s.CheckpointCount != 3 {
		t.Fatalf("checkpointCount = %d, want 3", s.CheckpointCount)
	}
	if len(s.Days) != 4 {
		t.Fatalf("days = %d, want 4", len(s.Days))
	}
	want := []struct {
		date      string
		pct       float64
		delta     float64
		pages     int64
		read      int64
		checkpont bool
	}{
		{"2026-11-01", 25, 25, 50, 50, true},
		{"2026-11-02", 25, 0, 50, 0, false},
		{"2026-11-03", 25, 0, 50, 0, true},
		{"2026-11-04", 100, 75, 200, 150, true},
	}
	for i, w := range want {
		d := s.Days[i]
		if d.Date != w.date || d.Percent != w.pct || d.DeltaPercent != w.delta || d.HasCheckpoint != w.checkpont {
			t.Errorf("day %d = %+v, want %+v", i, d, w)
		}
		if d.Pages == nil || *d.Pages != w.pages || d.PagesRead == nil || *d.PagesRead != w.read {
			t.Errorf("day %d pages = %v/%v, want %d/%d", i, d.Pages, d.PagesRead, w.pages, w.read)
		}
	}
}

func TestBuildFinishProgressSeriesWithoutPagesOrLogs(t *testing.T) {
	s := buildFinishProgressSeries("2026-11-01", "2026-11-02", nil, nil)
	if s.CheckpointCount != 0 || len(s.Days) != 2 {
		t.Fatalf("series = %+v", s)
	}
	for _, d := range s.Days {
		if d.Percent != 0 || d.Pages != nil || d.PagesRead != nil || d.HasCheckpoint {
			t.Fatalf("empty day = %+v", d)
		}
	}

	zero := int64(0)
	s = buildFinishProgressSeries("2026-11-01", "2026-11-01", []finishLog{{Date: "2026-11-01", Percent: 150}}, &zero)
	if len(s.Days) != 1 || s.Days[0].Percent != 100 || s.Days[0].Pages != nil {
		t.Fatalf("clamped day = %+v", s.Days)
	}
}

func TestBuildFinishProgressSeriesRejectsBadWindows(t *testing.T) {
	if s := buildFinishProgressSeries("2026-11-05", "2026-11-01", nil, nil); len(s.Days) != 0 {
		t.Fatalf("reversed window days = %d", len(s.Days))
	}
	if s := buildFinishProgressSeries("2000-01-01", "2026-11-01", nil, nil); len(s.Days) != 0 {
		t.Fatalf("overlong window days = %d", len(s.Days))
	}
	// The series is not capped at the 50 or 200 entries of the history endpoints.
	s := buildFinishProgressSeries("2025-01-01", "2025-12-31", nil, nil)
	if len(s.Days) != 365 {
		t.Fatalf("one-year window days = %d, want 365", len(s.Days))
	}
}
