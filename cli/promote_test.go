package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func promoReleases() []releaseSummary {
	return []releaseSummary{
		{ID: 5, Channel: "beta", Version: "2.1.0", BuildNumber: 12, FileKey: "app/MyApp-2.1.0.zip", FileSize: 2048},
		{ID: 4, Channel: "beta", Version: "2.0.0", BuildNumber: 10, FileKey: "app/MyApp-2.0.0.zip", FileSize: 2048},
		{ID: 2, Channel: "stable", Version: "1.9.0", BuildNumber: 8, FileKey: "app/MyApp-1.9.0.zip"},
		{ID: 1, Channel: "stable", Version: "1.8.0", BuildNumber: 7, FileKey: "app/MyApp-1.8.0.zip"},
	}
}

func TestPlanPromotion_PicksTheBetaRelease(t *testing.T) {
	r, err := planPromotion(promoReleases(), "2.1.0", "beta", "stable")
	if err != nil || r == nil || r.ID != 5 {
		t.Fatalf("expected release 5, got %+v, %v", r, err)
	}
}

func TestPlanPromotion_Refusals(t *testing.T) {
	yanked := promoReleases()
	yanked[0].Yanked = 1
	stableYanked := promoReleases()
	stableYanked[2].BuildNumber = 99 // a yanked stable release still counts
	stableYanked[2].Yanked = 1

	cases := []struct {
		name     string
		releases []releaseSummary
		version  string
		from, to string
		want     string
	}{
		{"unknown version", promoReleases(), "9.9.9", "beta", "stable", "no release v9.9.9"},
		{"version on the other channel", promoReleases(), "1.9.0", "beta", "stable", "no release v1.9.0"},
		{"same channel", promoReleases(), "2.1.0", "beta", "beta", "both"},
		{"yanked source", yanked, "2.1.0", "beta", "stable", "yanked"},
		{"build not higher than the target's latest", promoReleases(), "2.1.0", "beta", "stable", ""},
		{"a yanked release on the target still blocks", stableYanked, "2.1.0", "beta", "stable", "not higher"},
	}
	// build 12 > 8, so the "not higher" case needs a lower source build:
	low := promoReleases()
	low[0].BuildNumber = 6
	cases[4].releases, cases[4].want = low, "not higher"

	for _, tc := range cases {
		_, err := planPromotion(tc.releases, tc.version, tc.from, tc.to)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: expected an error containing %q, got %v", tc.name, tc.want, err)
		}
	}
}

func TestPlanPromotion_NotHigherExplainsTheFix(t *testing.T) {
	low := promoReleases()
	low[0].BuildNumber = 6
	_, err := planPromotion(low, "2.1.0", "beta", "stable")
	if err == nil || !strings.Contains(err.Error(), "publish a newer build") {
		t.Fatalf("the error should say what to do instead, got %v", err)
	}
}

func TestPlanPromotion_AlreadyThereIsNotAnError(t *testing.T) {
	rs := promoReleases()
	// promoted earlier: same file on the stable channel too
	rs = append([]releaseSummary{{ID: 6, Channel: "stable", Version: "2.0.0", BuildNumber: 10, FileKey: "app/MyApp-2.0.0.zip"}}, rs...)
	_, err := planPromotion(rs, "2.0.0", "beta", "stable")
	if !errors.Is(err, errAlreadyThere) {
		t.Fatalf("expected errAlreadyThere, got %v", err)
	}
}

func TestPromotionPlanLines(t *testing.T) {
	interval := 3600
	r := &releaseSummary{
		Channel: "beta", Version: "2.1.0", BuildNumber: 12, FileKey: "app/MyApp-2.1.0.zip", FileSize: 2048,
		MinSystemVersion: "13.0", Critical: 1, PhasedRolloutInterval: &interval,
		ReleaseNotes: "## What's new\n- faster",
	}
	got := strings.Join(promotionPlanLines("MyApp", r, "stable"), "\n")
	for _, want := range []string{"MyApp", "2.1.0 (build 12)", "beta -> stable", "MyApp-2.1.0.zip", "13.0", "critical: yes", "every 3600s", "What's new"} {
		if !strings.Contains(got, want) {
			t.Errorf("plan is missing %q:\n%s", want, got)
		}
	}
}

func TestDoPromote_SendsTheChannelAndMapsStatuses(t *testing.T) {
	cases := []struct {
		status  int
		body    string
		wantErr string // "" = success
	}{
		{http.StatusCreated, `{"id":9}`, ""},
		{http.StatusConflict, `{"error":"conflict","message":"Build 6 is not higher than the latest build (8)"}`, "not higher"},
		{http.StatusBadRequest, `{"error":"invalid_input","message":"channel must be 1-32 letters"}`, "channel must be"},
		{http.StatusNotFound, ``, "not found"},
		{http.StatusForbidden, ``, "publish-scoped"},
		{http.StatusInternalServerError, `boom`, "500"},
	}
	for _, tc := range cases {
		var gotMethod, gotPath, gotAuth string
		var gotBody map[string]string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
			json.NewDecoder(r.Body).Decode(&gotBody)
			w.WriteHeader(tc.status)
			w.Write([]byte(tc.body))
		}))
		err := doPromote(srv.URL, "tok", "app1", 5, "stable")
		srv.Close()

		if gotMethod != "POST" || gotPath != "/app1/releases/5/promote" || gotAuth != "Bearer tok" || gotBody["channel"] != "stable" {
			t.Fatalf("status %d: unexpected request %s %s %q %v", tc.status, gotMethod, gotPath, gotAuth, gotBody)
		}
		if tc.wantErr == "" && err != nil {
			t.Fatalf("status %d: unexpected error %v", tc.status, err)
		}
		if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Fatalf("status %d: expected error containing %q, got %v", tc.status, tc.wantErr, err)
		}
	}
}

func TestFirstLine(t *testing.T) {
	if got := firstLine("## Title\nmore"); got != "## Title …" {
		t.Errorf("unexpected: %q", got)
	}
	if got := firstLine(strings.Repeat("x", 100)); len(got) > 75 || !strings.HasSuffix(got, "…") {
		t.Errorf("long notes should be cut: %q", got)
	}
	if got := firstLine("  "); got != "" {
		t.Errorf("blank notes should give nothing: %q", got)
	}
}
