package main

import "testing"

func mkRelease(channel, version string, build int) releaseSummary {
	return releaseSummary{Channel: channel, Version: version, BuildNumber: build}
}

func TestReleasesBeyondHistoryLimit(t *testing.T) {
	t.Run("nothing beyond the limit when a channel has fewer releases than the limit", func(t *testing.T) {
		releases := []releaseSummary{
			mkRelease("stable", "1.0.0", 1),
			mkRelease("stable", "1.1.0", 2),
		}
		got := releasesBeyondHistoryLimit(releases, 10)
		if len(got) != 0 {
			t.Fatalf("expected no candidates, got %+v", got)
		}
	})

	t.Run("exactly at the limit keeps everything", func(t *testing.T) {
		releases := []releaseSummary{
			mkRelease("stable", "3", 3),
			mkRelease("stable", "2", 2),
			mkRelease("stable", "1", 1),
		}
		got := releasesBeyondHistoryLimit(releases, 3)
		if len(got) != 0 {
			t.Fatalf("expected no candidates when count == limit, got %+v", got)
		}
	})

	t.Run("keeps the first N (newest, given server sort order) and flags the rest", func(t *testing.T) {
		// Mirrors the server's channel ASC, build_number DESC ordering:
		// within a channel, entries arrive newest-build-first.
		releases := []releaseSummary{
			mkRelease("stable", "5", 5),
			mkRelease("stable", "4", 4),
			mkRelease("stable", "3", 3),
			mkRelease("stable", "2", 2),
			mkRelease("stable", "1", 1),
		}
		got := releasesBeyondHistoryLimit(releases, 2)
		if len(got) != 3 {
			t.Fatalf("expected 3 candidates beyond the top 2, got %d: %+v", len(got), got)
		}
		for _, r := range got {
			if r.BuildNumber >= 4 {
				t.Fatalf("build %d should have been kept (within the top 2), not flagged for deletion", r.BuildNumber)
			}
		}
	})

	t.Run("each channel is windowed independently", func(t *testing.T) {
		releases := []releaseSummary{
			mkRelease("beta", "b3", 3),
			mkRelease("beta", "b2", 2),
			mkRelease("beta", "b1", 1),
			mkRelease("stable", "s2", 2),
			mkRelease("stable", "s1", 1),
		}
		got := releasesBeyondHistoryLimit(releases, 2)
		if len(got) != 1 {
			t.Fatalf("expected exactly 1 candidate (beta build 1), got %d: %+v", len(got), got)
		}
		if got[0].Channel != "beta" || got[0].BuildNumber != 1 {
			t.Fatalf("expected beta build 1 to be the only candidate, got %+v", got[0])
		}
	})

	t.Run("never flags every release in a channel — a channel at or under the limit is fully kept", func(t *testing.T) {
		// This is the property that makes the server's last-release guard
		// unreachable from cleanup's own selection: as long as
		// historyLimit >= 1, a channel with N <= historyLimit releases
		// never contributes any candidates, so cleanup can never attempt
		// to empty a channel on its own.
		releases := []releaseSummary{mkRelease("stable", "1", 1)}
		got := releasesBeyondHistoryLimit(releases, 1)
		if len(got) != 0 {
			t.Fatalf("expected the sole release to be kept, got %+v", got)
		}
	})

	t.Run("empty input yields no candidates", func(t *testing.T) {
		got := releasesBeyondHistoryLimit(nil, 10)
		if len(got) != 0 {
			t.Fatalf("expected no candidates for empty input, got %+v", got)
		}
	})
}
