package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// cmdRedirect points an app's feed URL at another host (or clears that). The
// URL is baked into every installed copy, so a redirect from the old address
// is the only way to bring them along without shipping a release.
func cmdRedirect(args []string) {
	cfg := loadProjectConfig()
	appDefault := ""
	if cfg != nil {
		appDefault = cfg.App
	}

	fs := flag.NewFlagSet("redirect", flag.ExitOnError)
	appID := fs.String("app", appDefault, "the app — defaults to .railcast.json in this directory")
	fs.StringVar(appID, "a", appDefault, "shorthand for --app")
	to := fs.String("to", "", "the new feed URL, e.g. https://updates.myapp.com/appcast.xml")
	clear := fs.Bool("clear", false, "remove the redirect and serve the feed from Railcast again")
	force := fs.Bool("force", false, "set the redirect even if the target doesn't look like an appcast")
	token := fs.String("token", "", "API token with publish scope (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
	fs.StringVar(token, "t", "", "shorthand for --token")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)
	*token = resolveToken(*token)

	if *appID == "" {
		fail("missing required flag: --app (or run this from a directory with a .railcast.json)")
	}
	if *token == "" {
		fail("missing required flag: --token (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}
	if *to != "" && *clear {
		fail("--to and --clear can't be combined")
	}

	switch {
	case *clear:
		if err := doSetFeedRedirect(*baseURL, *token, *appID, nil); err != nil {
			fail("%v", err)
		}
		fmt.Println("Redirect cleared — the feed is served from Railcast again.")

	case *to != "":
		if err := checkRedirectTarget(*to); err != nil {
			if !*force {
				fail("not setting the redirect: %v\n\nFix the target, or pass --force if you know better.", err)
			}
			fmt.Printf("Warning: %v (continuing because of --force)\n\n", err)
		}
		if err := doSetFeedRedirect(*baseURL, *token, *appID, to); err != nil {
			fail("%v", err)
		}
		fmt.Printf("Done. %s/%s/appcast.xml now redirects (302) to:\n  %s\n\n", strings.TrimRight(*baseURL, "/"), *appID, *to)
		if !strings.HasSuffix(strings.SplitN(*to, "?", 2)[0], "/appcast.xml") {
			fmt.Println("Note: the beta channel can only follow if the URL ends in /appcast.xml")
			fmt.Println("(it maps to appcast-beta.xml next to it). Otherwise beta stays served from here.")
			fmt.Println()
		}
		fmt.Println("Keep the new feed signed with the same key — installed copies still trust the")
		fmt.Println("SUPublicEDKey they shipped with. Undo any time: railcast redirect --clear")

	default:
		apps, err := doListApps(*baseURL, *token)
		if err != nil {
			fail("could not look up the app: %v", err)
		}
		for _, a := range apps {
			if a.ID != *appID {
				continue
			}
			if a.FeedRedirectURL == "" {
				fmt.Println("No redirect set — the feed is served from Railcast.")
			} else {
				fmt.Printf("Feed redirects to: %s\n", a.FeedRedirectURL)
			}
			return
		}
		fail("no app with id %q visible to this token", *appID)
	}
}

// checkRedirectTarget fetches the new feed and checks it looks like an
// appcast, so a typo can't strand every installed copy on a dead address.
func checkRedirectTarget(target string) error {
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get(target)
	if err != nil {
		return fmt.Errorf("couldn't fetch %s: %v", target, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered HTTP %d, not 200", target, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return fmt.Errorf("couldn't read %s: %v", target, err)
	}
	if !bytes.Contains(body, []byte("<rss")) || !bytes.Contains(body, []byte("<item")) {
		return fmt.Errorf("%s doesn't look like an appcast (no <rss> with at least one <item>)", target)
	}
	return nil
}

// doSetFeedRedirect calls PUT /:appId/feed-redirect; a nil target clears it.
func doSetFeedRedirect(baseURL, token, appID string, target *string) error {
	payload, _ := json.Marshal(map[string]interface{}{"url": target})
	url := fmt.Sprintf("%s/%s/feed-redirect", strings.TrimRight(baseURL, "/"), appID)
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(payload))
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

	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusBadRequest:
		var e struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &e) == nil && e.Message != "" {
			return fmt.Errorf("server rejected the URL: %s", e.Message)
		}
		return fmt.Errorf("server rejected the request: %s", strings.TrimSpace(string(body)))
	case http.StatusForbidden:
		return fmt.Errorf("token can't do that — it needs publish scope for this app")
	case http.StatusNotFound:
		return fmt.Errorf("no app with id %q", appID)
	}
	return fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
}
