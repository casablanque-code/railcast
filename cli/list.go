package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

type appSummary struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	SigningPublicKey string `json:"signing_public_key"`
	BetaToken        string `json:"beta_token"`
	CreatedAt        int64  `json:"created_at"`
}

type releaseSummary struct {
	ID                    int64  `json:"id"`
	Channel               string `json:"channel"`
	Version               string `json:"version"`
	BuildNumber           int    `json:"build_number"`
	FileKey               string `json:"file_key"`
	FileSize              int64  `json:"file_size"`
	SHA256                string `json:"sha256"`
	ReleaseNotes          string `json:"release_notes"`
	Critical              int    `json:"critical"` // D1 stores 0/1, not a JSON bool
	PhasedRolloutInterval *int   `json:"phased_rollout_interval"`
	CreatedAt             int64  `json:"created_at"`
}

type appReleases struct {
	AppID    string           `json:"app_id"`
	AppName  string           `json:"app_name"`
	Releases []releaseSummary `json:"releases"`
}

func cmdList(args []string) {
	cfg := loadProjectConfig()
	appDefault := ""
	if cfg != nil {
		appDefault = cfg.App
	}

	fs := flag.NewFlagSet("list", flag.ExitOnError)
	appID := fs.String("app", appDefault, "only list this app's releases — defaults to .railcast.json in this directory if present, otherwise every app the token can see")
	fs.StringVar(appID, "a", appDefault, "shorthand for --app")
	token := fs.String("token", "", "API token (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
	fs.StringVar(token, "t", "", "shorthand for --token")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	asJSON := fs.Bool("json", false, "print raw JSON instead of a formatted table")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)
	*token = resolveToken(*token)

	if *token == "" {
		fail("missing required flag: --token (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}

	var groups []appReleases

	if *appID != "" {
		// A single app was named (explicitly, or via .railcast.json) — skip
		// listing every app on the account, which also means this works
		// fine with a per-app scoped token that couldn't see the others
		// anyway.
		name, releases, _, err := doListReleases(*baseURL, *token, *appID)
		if err != nil {
			fail("could not list releases: %v", err)
		}
		groups = append(groups, appReleases{AppID: *appID, AppName: name, Releases: releases})
	} else {
		apps, err := doListApps(*baseURL, *token)
		if err != nil {
			fail("could not list apps: %v", err)
		}
		if len(apps) == 0 {
			fmt.Println("No apps yet — run 'railcast init' to create one.")
			return
		}
		for _, a := range apps {
			_, releases, _, err := doListReleases(*baseURL, *token, a.ID)
			if err != nil {
				// Don't let one app's transient error hide every other
				// app's releases — report it and keep going.
				fmt.Printf("Warning: could not list releases for %s (%s): %v\n", a.Name, a.ID, err)
				continue
			}
			groups = append(groups, appReleases{AppID: a.ID, AppName: a.Name, Releases: releases})
		}
	}

	if *asJSON {
		out, err := json.MarshalIndent(groups, "", "  ")
		if err != nil {
			fail("could not format output: %v", err)
		}
		fmt.Println(string(out))
		return
	}

	for i, g := range groups {
		if i > 0 {
			fmt.Println()
		}
		printAppReleases(g.AppID, g.AppName, g.Releases)
	}
}

func printAppReleases(appID, appName string, releases []releaseSummary) {
	label := appName
	if label == "" {
		label = appID
	}
	if colorEnabled() {
		fmt.Printf("%s%s%s %s(%s)%s\n", ansiBold, label, ansiReset, ansiDim, appID, ansiReset)
	} else {
		fmt.Printf("%s (%s)\n", label, appID)
	}

	if len(releases) == 0 {
		fmt.Println("  (no published releases yet)")
		return
	}

	// The server returns releases ordered channel ASC, build_number DESC
	// (see handleListReleases) — the first row seen for a given channel is
	// therefore that channel's current latest, with no extra sorting needed
	// here.
	seenChannel := map[string]bool{}

	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, r := range releases {
		isLatest := !seenChannel[r.Channel]
		seenChannel[r.Channel] = true

		var flags []string
		if isLatest {
			flags = append(flags, "latest")
		}
		if r.Critical != 0 {
			flags = append(flags, "critical")
		}
		flagStr := ""
		if len(flags) > 0 {
			flagStr = "[" + strings.Join(flags, ", ") + "]"
		}

		fmt.Fprintf(tw, "  %s\tv%s\tbuild %d\t%s\t%s\t%s\n",
			r.Channel, r.Version, r.BuildNumber, humanSize(r.FileSize), relativeTime(r.CreatedAt), flagStr)
	}
	tw.Flush()
}

// humanSize formats a byte count the way `ls -lh`/du do: 1.0 KiB, 4.2 MiB,
// etc. — binary (1024-based) units, since that's what the size on disk
// actually reflects.
func humanSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// relativeTime renders a Unix timestamp as "3d ago" etc. — good enough
// precision for a release list; nobody needs seconds-level accuracy here.
func relativeTime(unixSeconds int64) string {
	d := time.Since(time.Unix(unixSeconds, 0))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	default:
		return fmt.Sprintf("%dmo ago", int(d.Hours()/24/30))
	}
}

func doListApps(baseURL, token string) ([]appSummary, error) {
	url := fmt.Sprintf("%s/api/apps", strings.TrimRight(baseURL, "/"))
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("unauthorized — check --token / $RAILCAST_TOKEN")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
	}

	var out struct {
		Apps []appSummary `json:"apps"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("could not parse response: %w", err)
	}
	return out.Apps, nil
}

func doListReleases(baseURL, token, appID string) (appName string, releases []releaseSummary, historyLimit int, err error) {
	url := fmt.Sprintf("%s/%s/releases", strings.TrimRight(baseURL, "/"), appID)
	req, reqErr := http.NewRequest(http.MethodGet, url, nil)
	if reqErr != nil {
		return "", nil, 0, reqErr
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, doErr := http.DefaultClient.Do(req)
	if doErr != nil {
		return "", nil, 0, doErr
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return "", nil, 0, fmt.Errorf(
			"no app with id %q — --app takes the id from .railcast.json (or the one printed by 'railcast init'), not the name you gave --app at init time",
			appID,
		)
	}
	if resp.StatusCode == http.StatusForbidden {
		return "", nil, 0, fmt.Errorf("token doesn't have access to app %q", appID)
	}
	if resp.StatusCode != http.StatusOK {
		return "", nil, 0, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
	}

	var out struct {
		AppName      string           `json:"app_name"`
		HistoryLimit int              `json:"history_limit"`
		Releases     []releaseSummary `json:"releases"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", nil, 0, fmt.Errorf("could not parse response: %w", err)
	}
	// Defensive default in case an older/differently configured server
	// doesn't send history_limit at all — better to fall back to the
	// appcast's documented default than to treat 0 as "keep nothing".
	if out.HistoryLimit <= 0 {
		out.HistoryLimit = 10
	}
	return out.AppName, out.Releases, out.HistoryLimit, nil
}

// doDeleteRelease calls DELETE /:appId/releases/:id. A 409 means the
// server's own last-release-on-a-channel guard refused it (see
// handleDeleteRelease) — surfaced as a normal error the caller can print,
// not a crash, since `railcast cleanup` may legitimately race a concurrent
// publish/delete and hit this.
func doDeleteRelease(baseURL, token, appID string, releaseID int64) error {
	url := fmt.Sprintf("%s/%s/releases/%d", strings.TrimRight(baseURL, "/"), appID, releaseID)
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusConflict {
		return fmt.Errorf("refused: this is the only release left on its channel")
	}
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("not found (already deleted?)")
	}
	return fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
}
