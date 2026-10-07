package main

import (
	"flag"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// cmdYank hides a release from the appcast (or brings it back with --undo)
// without deleting anything. Sparkle never downgrades: yanking makes new
// update checks get the previous release again, but anyone who already
// installed the bad one stays on it until a build with a higher number is
// published.
func cmdYank(args []string) {
	// The version comes first (`railcast yank 1.4.2 --channel beta`): the flag
	// package stops at the first non-flag argument, so peel it off ourselves.
	positional := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		positional, args = args[0], args[1:]
	}

	cfg := loadProjectConfig()
	appDefault := ""
	if cfg != nil {
		appDefault = cfg.App
	}

	fs := flag.NewFlagSet("yank", flag.ExitOnError)
	appID := fs.String("app", appDefault, "the app — defaults to .railcast.json in this directory")
	fs.StringVar(appID, "a", appDefault, "shorthand for --app")
	channel := fs.String("channel", "stable", "channel the release is on")
	undo := fs.Bool("undo", false, "bring a yanked release back into the feed")
	token := fs.String("token", "", "API token (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
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
		fail("usage: railcast yank <version> [--channel stable] [--undo]\n\nSee 'railcast list' for the versions of this app.")
	}
	if *appID == "" {
		fail("missing required flag: --app (or run this from a directory with a .railcast.json)")
	}
	if *token == "" {
		fail("missing required flag: --token (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}

	_, releases, _, err := doListReleases(*baseURL, *token, *appID)
	if err != nil {
		fail("could not list releases: %v", err)
	}

	target := findRelease(releases, version, *channel)
	if target == nil {
		fail("no release v%s on channel %q.\nAvailable on that channel: %s", version, *channel, availableVersions(releases, *channel))
	}

	if *undo {
		if target.Yanked == 0 {
			fmt.Printf("v%s (%s) isn't yanked — nothing to do.\n", target.Version, target.Channel)
			return
		}
	} else if target.Yanked != 0 {
		fmt.Printf("v%s (%s) is already yanked — nothing to do.\n", target.Version, target.Channel)
		return
	}

	if err := doSetYanked(*baseURL, *token, *appID, target.ID, !*undo); err != nil {
		fail("%v", err)
	}

	if *undo {
		fmt.Printf("Restored v%s (%s, build %d) to the feed.\n", target.Version, target.Channel, target.BuildNumber)
		return
	}
	fmt.Printf("Yanked v%s (%s, build %d).\n", target.Version, target.Channel, target.BuildNumber)
	if prev := latestLive(releases, target.Channel, target.ID); prev != nil {
		fmt.Printf("New update checks now get v%s (build %d).\n", prev.Version, prev.BuildNumber)
	}
	fmt.Println()
	fmt.Println("Anyone who already installed it keeps it: Sparkle never downgrades.")
	fmt.Println("Publish a fixed build with a higher build number to move them on.")
	fmt.Printf("Undo with: railcast yank %s --channel %s --undo\n", target.Version, target.Channel)
}

// findRelease returns the release with this version on this channel, or nil.
func findRelease(releases []releaseSummary, version, channel string) *releaseSummary {
	for i := range releases {
		if releases[i].Version == version && releases[i].Channel == channel {
			return &releases[i]
		}
	}
	return nil
}

// latestLive returns the highest-build non-yanked release on the channel,
// ignoring the one with id `except` (the release being yanked) — i.e. what
// the feed will serve first afterwards.
func latestLive(releases []releaseSummary, channel string, except int64) *releaseSummary {
	var best *releaseSummary
	for i := range releases {
		r := &releases[i]
		if r.Channel != channel || r.Yanked != 0 || r.ID == except {
			continue
		}
		if best == nil || r.BuildNumber > best.BuildNumber {
			best = r
		}
	}
	return best
}

func availableVersions(releases []releaseSummary, channel string) string {
	var versions []string
	for _, r := range releases {
		if r.Channel == channel {
			versions = append(versions, "v"+r.Version)
		}
	}
	if len(versions) == 0 {
		return "(none — check --channel)"
	}
	sort.Strings(versions)
	return strings.Join(versions, ", ")
}

// doSetYanked calls POST /:appId/releases/:id/yank or /unyank.
func doSetYanked(baseURL, token, appID string, releaseID int64, yank bool) error {
	action := "unyank"
	if yank {
		action = "yank"
	}
	url := fmt.Sprintf("%s/%s/releases/%d/%s", strings.TrimRight(baseURL, "/"), appID, releaseID, action)
	req, err := http.NewRequest(http.MethodPost, url, nil)
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
	switch resp.StatusCode {
	case http.StatusConflict:
		return fmt.Errorf("refused: this is the only live release on its channel — publish a replacement first")
	case http.StatusNotFound:
		return fmt.Errorf("not found (was it deleted?)")
	case http.StatusForbidden:
		return fmt.Errorf("token can't do that — yanking needs a publish-scoped token for this app")
	}
	return fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
}
