package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
)

// cmdCleanup deletes releases that have fallen out of the appcast's
// history window (see APPCAST_HISTORY_LIMIT on the server, surfaced here
// as history_limit) — the ones nobody's Sparkle client can reach anymore
// anyway, since appcast.xml only ever serves the most recent N per channel.
//
// This is deliberately manual, not a background cron job: the person
// running it sees exactly what would be deleted before anything happens,
// and has to confirm (or pass --yes for scripting/CI).
//
// The actual "don't empty a channel" safety net lives server-side in
// handleDeleteRelease (a 409 if a delete would leave a channel with zero
// releases) — the selection logic below can't produce that case anyway
// (it only ever considers releases beyond the kept window, so at least
// history_limit releases always remain per channel), but the server
// enforces the invariant regardless of what this command computes.
func cmdCleanup(args []string) {
	cfg := loadProjectConfig()
	appDefault := ""
	if cfg != nil {
		appDefault = cfg.App
	}

	fs := flag.NewFlagSet("cleanup", flag.ExitOnError)
	appID := fs.String("app", appDefault, "the app to clean up — defaults to .railcast.json in this directory")
	fs.StringVar(appID, "a", appDefault, "shorthand for --app")
	token := fs.String("token", "", "API token (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
	fs.StringVar(token, "t", "", "shorthand for --token")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	yes := fs.Bool("yes", false, "delete without prompting for confirmation (for scripts/CI)")
	dryRun := fs.Bool("dry-run", false, "only show what would be deleted; never deletes, never prompts")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)
	*token = resolveToken(*token)

	if *appID == "" {
		fail("missing required flag: --app (or run this from a directory with a .railcast.json)")
	}
	if *token == "" {
		fail("missing required flag: --token (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}

	appName, releases, historyLimit, err := doListReleases(*baseURL, *token, *appID)
	if err != nil {
		fail("could not list releases: %v", err)
	}

	candidates := releasesBeyondHistoryLimit(releases, historyLimit)

	label := appName
	if label == "" {
		label = *appID
	}

	if len(candidates) == 0 {
		fmt.Printf("%s (%s): nothing to clean up — every channel has %d or fewer releases.\n", label, *appID, historyLimit)
		return
	}

	fmt.Printf("%s (%s): %d release(s) beyond the last %d per channel:\n\n", label, *appID, len(candidates), historyLimit)
	printCleanupCandidates(candidates)
	fmt.Println()

	if *dryRun {
		fmt.Println("Dry run — nothing deleted. Re-run with --yes to actually delete these.")
		return
	}

	if !*yes {
		if !confirm(fmt.Sprintf("Delete these %d release(s)? [y/N] ", len(candidates))) {
			fmt.Println("Aborted — nothing deleted.")
			return
		}
	}

	deleted, failed := 0, 0
	for _, c := range candidates {
		if err := doDeleteRelease(*baseURL, *token, *appID, c.ID); err != nil {
			fmt.Printf("  failed: %s v%s build %d — %v\n", c.Channel, c.Version, c.BuildNumber, err)
			failed++
			continue
		}
		deleted++
	}

	fmt.Printf("\nDeleted %d release(s)", deleted)
	if failed > 0 {
		fmt.Printf(", %d failed", failed)
	}
	fmt.Println(".")
	if failed > 0 {
		os.Exit(1)
	}
}

// releasesBeyondHistoryLimit returns every release past the first
// historyLimit entries within its own channel. It relies on the server
// already sorting releases channel ASC, build_number DESC (see
// handleListReleases) — the first historyLimit rows seen for a channel are
// that channel's currently-served appcast window, and everything after
// that has already fallen out of it.
func releasesBeyondHistoryLimit(releases []releaseSummary, historyLimit int) []releaseSummary {
	seenInChannel := map[string]int{}
	var beyond []releaseSummary
	for _, r := range releases {
		seenInChannel[r.Channel]++
		if seenInChannel[r.Channel] > historyLimit {
			beyond = append(beyond, r)
		}
	}
	return beyond
}

func printCleanupCandidates(candidates []releaseSummary) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, r := range candidates {
		fmt.Fprintf(tw, "  %s\tv%s\tbuild %d\t%s\t%s\n",
			r.Channel, r.Version, r.BuildNumber, humanSize(r.FileSize), relativeTime(r.CreatedAt))
	}
	tw.Flush()
}

// confirm prompts on stdout and reads a line from stdin. Anything other
// than a leading 'y'/'Y' (including EOF, e.g. stdin isn't a terminal and
// nothing was piped in) is treated as "no" — an unanswerable prompt must
// never be interpreted as consent to delete things.
func confirm(prompt string) bool {
	fmt.Print(prompt)
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}
