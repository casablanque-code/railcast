package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// errAlreadyThere is not a failure: the release is already on the target channel.
var errAlreadyThere = errors.New("already on the target channel")

// cmdPromote releases a build that is already published on one channel
// (typically beta) to another (stable by default) without uploading it again:
// same file, signature, hash and notes. The build number is kept — it is baked
// into the app itself — so it has to be higher than what the target channel
// already has.
func cmdPromote(args []string) {
	// The version comes first (`railcast promote 1.4.2 --yes`): the flag package
	// stops at the first non-flag argument, so peel it off ourselves.
	positional := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		positional, args = args[0], args[1:]
	}

	cfg := loadProjectConfig()
	appDefault := ""
	if cfg != nil {
		appDefault = cfg.App
	}

	fs := flag.NewFlagSet("promote", flag.ExitOnError)
	appID := fs.String("app", appDefault, "the app — defaults to .railcast.json in this directory")
	fs.StringVar(appID, "a", appDefault, "shorthand for --app")
	from := fs.String("from", "beta", "channel the release is on now")
	to := fs.String("to", "stable", "channel to release it to")
	yes := fs.Bool("yes", false, "don't ask for confirmation (for scripts/CI — it goes to every user on the target channel)")
	token := fs.String("token", "", "API token with publish scope (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
	fs.StringVar(token, "t", "", "shorthand for --token")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)
	*token = resolveToken(*token)

	if positional == "" && fs.NArg() > 0 {
		positional = fs.Arg(0)
	}
	version := strings.TrimPrefix(positional, "v")
	if version == "" {
		fail("usage: railcast promote <version> [--from beta] [--to stable] [--yes]\n\nSee 'railcast list' for the versions of this app.")
	}
	if *appID == "" {
		fail("missing required flag: --app (or run this from a directory with a .railcast.json)")
	}
	if *token == "" {
		fail("missing required flag: --token (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}

	appName, releases, _, err := doListReleases(*baseURL, *token, *appID)
	if err != nil {
		fail("could not list releases: %v", err)
	}

	source, err := planPromotion(releases, version, *from, *to)
	if errors.Is(err, errAlreadyThere) {
		fmt.Printf("v%s is already on channel %q — nothing to do.\n", version, *to)
		return
	}
	if err != nil {
		fail("%v", err)
	}

	label := appName
	if label == "" {
		label = *appID
	}
	printBox("Promotion plan", promotionPlanLines(label, source, *to)...)
	fmt.Println()

	if !*yes {
		fmt.Printf("This goes to every user on %q at their next update check, and Sparkle never downgrades.\n", *to)
		if !confirm(fmt.Sprintf("Release v%s to %s? [y/N] ", source.Version, *to)) {
			fmt.Println("Cancelled — nothing changed.")
			return
		}
	}

	if err := doPromote(*baseURL, *token, *appID, source.ID, *to); err != nil {
		fail("%v", err)
	}

	feed := fmt.Sprintf("%s/%s/appcast.xml", strings.TrimRight(*baseURL, "/"), *appID)
	if *to != "stable" {
		feed += "?channel=" + url.QueryEscape(*to)
	}
	fmt.Printf("\nPromoted v%s (build %d) to %s.\n  feed: %s\n", source.Version, source.BuildNumber, *to, feed)
	fmt.Printf("Pull it again with: railcast yank %s --channel %s\n", source.Version, *to)
}

// planPromotion finds the release to promote and checks everything the server
// would check, so problems are explained before anything is asked or sent.
func planPromotion(releases []releaseSummary, version, from, to string) (*releaseSummary, error) {
	if from == to {
		return nil, fmt.Errorf("--from and --to are both %q", from)
	}
	source := findRelease(releases, version, from)
	if source == nil {
		return nil, fmt.Errorf("no release v%s on channel %q.\nAvailable on that channel: %s", version, from, availableVersions(releases, from))
	}
	if source.Yanked != 0 {
		return nil, fmt.Errorf("v%s (%s) is yanked — restore it first: railcast yank %s --channel %s --undo", version, from, version, from)
	}

	latest := 0
	for _, r := range releases {
		if r.Channel != to {
			continue
		}
		if r.FileKey == source.FileKey || (r.Version == source.Version && r.BuildNumber == source.BuildNumber) {
			return nil, errAlreadyThere
		}
		if r.BuildNumber > latest {
			latest = r.BuildNumber // yanked releases count too, same as when publishing
		}
	}
	if source.BuildNumber <= latest {
		return nil, fmt.Errorf(
			"build %d is not higher than the latest build (%d) on %q, so Sparkle would never offer it there.\n"+
				"The build number is part of the app itself and can't be changed here — publish a newer build instead.",
			source.BuildNumber, latest, to)
	}
	return source, nil
}

func promotionPlanLines(app string, r *releaseSummary, to string) []string {
	lines := []string{
		fmt.Sprintf("app:     %s", app),
		fmt.Sprintf("version: %s (build %d)", r.Version, r.BuildNumber),
		fmt.Sprintf("move:    %s -> %s", r.Channel, to),
		fmt.Sprintf("file:    %s (%s, already uploaded — not sent again)", baseName(r.FileKey), humanSize(r.FileSize)),
	}
	if r.MinSystemVersion != "" {
		lines = append(lines, fmt.Sprintf("macOS:   %s or newer", r.MinSystemVersion))
	}
	if r.Critical != 0 {
		lines = append(lines, "critical: yes")
	}
	if r.PhasedRolloutInterval != nil && *r.PhasedRolloutInterval > 0 {
		lines = append(lines, fmt.Sprintf("phased rollout: every %ds", *r.PhasedRolloutInterval))
	}
	if first := firstLine(r.ReleaseNotes); first != "" {
		lines = append(lines, fmt.Sprintf("notes:   %s", first))
	}
	return lines
}

func baseName(key string) string {
	if i := strings.LastIndex(key, "/"); i >= 0 {
		return key[i+1:]
	}
	return key
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i]) + " …"
	}
	if len(s) > 70 {
		s = s[:69] + "…"
	}
	return s
}

// doPromote calls POST /:appId/releases/:id/promote.
func doPromote(baseURL, token, appID string, releaseID int64, channel string) error {
	payload, _ := json.Marshal(map[string]string{"channel": channel})
	u := fmt.Sprintf("%s/%s/releases/%d/promote", strings.TrimRight(baseURL, "/"), appID, releaseID)
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusCreated {
		return nil
	}
	var e struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &e)
	switch resp.StatusCode {
	case http.StatusConflict, http.StatusBadRequest:
		if e.Message != "" {
			return fmt.Errorf("refused: %s", e.Message)
		}
	case http.StatusNotFound:
		return fmt.Errorf("not found (was it deleted?)")
	case http.StatusForbidden:
		return fmt.Errorf("token can't do that — promoting needs a publish-scoped token for this app")
	}
	return fmt.Errorf("server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}
