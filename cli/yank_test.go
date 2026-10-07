package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sampleReleases() []releaseSummary {
	return []releaseSummary{
		{ID: 3, Channel: "beta", Version: "2.0.0-b1", BuildNumber: 30},
		{ID: 2, Channel: "stable", Version: "1.1.0", BuildNumber: 20},
		{ID: 1, Channel: "stable", Version: "1.0.0", BuildNumber: 10},
	}
}

func TestFindRelease_MatchesVersionAndChannel(t *testing.T) {
	rs := sampleReleases()
	if r := findRelease(rs, "1.1.0", "stable"); r == nil || r.ID != 2 {
		t.Fatalf("expected release 2, got %+v", r)
	}
	if r := findRelease(rs, "1.1.0", "beta"); r != nil {
		t.Fatalf("version on the wrong channel must not match, got %+v", r)
	}
	if r := findRelease(rs, "9.9.9", "stable"); r != nil {
		t.Fatalf("unknown version must not match, got %+v", r)
	}
}

func TestLatestLive_SkipsYankedAndTheExcludedRelease(t *testing.T) {
	rs := sampleReleases()
	if r := latestLive(rs, "stable", 2); r == nil || r.ID != 1 {
		t.Fatalf("after yanking 1.1.0 the feed should serve 1.0.0, got %+v", r)
	}
	rs[2].Yanked = 1
	if r := latestLive(rs, "stable", 2); r != nil {
		t.Fatalf("nothing live should be left, got %+v", r)
	}
}

func TestAvailableVersions_ListsOnlyTheChannel(t *testing.T) {
	got := availableVersions(sampleReleases(), "stable")
	if !strings.Contains(got, "v1.0.0") || !strings.Contains(got, "v1.1.0") || strings.Contains(got, "b1") {
		t.Fatalf("unexpected list: %s", got)
	}
	if !strings.Contains(availableVersions(sampleReleases(), "nope"), "none") {
		t.Fatal("expected a hint for an unknown channel")
	}
}

func TestDoSetYanked_MapsStatusCodes(t *testing.T) {
	cases := []struct {
		status  int
		wantErr string // "" = success
	}{
		{http.StatusNoContent, ""},
		{http.StatusConflict, "only live release"},
		{http.StatusNotFound, "not found"},
		{http.StatusForbidden, "publish-scoped"},
		{http.StatusInternalServerError, "500"},
	}
	for _, tc := range cases {
		var gotPath, gotAuth string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotPath, gotAuth = r.Method+" "+r.URL.Path, r.Header.Get("Authorization")
			w.WriteHeader(tc.status)
		}))
		err := doSetYanked(srv.URL, "tok", "app1", 7, true)
		srv.Close()

		if gotPath != "POST /app1/releases/7/yank" || gotAuth != "Bearer tok" {
			t.Fatalf("status %d: unexpected request %q auth %q", tc.status, gotPath, gotAuth)
		}
		if tc.wantErr == "" && err != nil {
			t.Fatalf("status %d: unexpected error %v", tc.status, err)
		}
		if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Fatalf("status %d: expected error containing %q, got %v", tc.status, tc.wantErr, err)
		}
	}
}

func TestDoSetYanked_UnyankUsesTheOtherEndpoint(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := doSetYanked(srv.URL, "tok", "app1", 7, false); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/app1/releases/7/unyank" {
		t.Fatalf("unexpected path %s", gotPath)
	}
}

func TestReleasesBeyondHistoryLimit_IgnoresYanked(t *testing.T) {
	// Window of 2 live releases: 5 is yanked and doesn't use a slot, so 3 and 4
	// stay, 2 and 1 are beyond — and the yanked one is never proposed.
	rs := []releaseSummary{
		{ID: 5, Channel: "stable", BuildNumber: 5, Yanked: 1},
		{ID: 4, Channel: "stable", BuildNumber: 4},
		{ID: 3, Channel: "stable", BuildNumber: 3},
		{ID: 2, Channel: "stable", BuildNumber: 2},
		{ID: 1, Channel: "stable", BuildNumber: 1},
	}
	got := releasesBeyondHistoryLimit(rs, 2)
	if len(got) != 2 || got[0].ID != 2 || got[1].ID != 1 {
		t.Fatalf("unexpected candidates: %+v", got)
	}
}
