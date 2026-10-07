package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// exportResponse mirrors GET /:appId/export.
type exportResponse struct {
	App struct {
		ID               string `json:"id"`
		Name             string `json:"name"`
		SigningPublicKey string `json:"signing_public_key"`
	} `json:"app"`
	PublicFileBaseURL string            `json:"public_file_base_url"`
	Releases          []releaseSummary  `json:"releases"`
	Appcasts          map[string]string `json:"appcasts"`
}

// cmdExport is the way out: it downloads every release file, checks each
// against the recorded sha256, and writes the signatures/metadata plus
// ready-to-host appcasts to disk. Safe to re-run — files that are already
// there and match their hash are skipped.
func cmdExport(args []string) {
	cfg := loadProjectConfig()
	appDefault := ""
	if cfg != nil {
		appDefault = cfg.App
	}

	fs := flag.NewFlagSet("export", flag.ExitOnError)
	appID := fs.String("app", appDefault, "the app to export — defaults to .railcast.json in this directory")
	fs.StringVar(appID, "a", appDefault, "shorthand for --app")
	outDir := fs.String("out", "", "directory to write to (created if missing)")
	fs.StringVar(outDir, "o", "", "shorthand for --out")
	filesURL := fs.String("files-url", "", "https URL the files/ folder will be served from, e.g. https://updates.myapp.com/files — enables appcast XML output")
	token := fs.String("token", "", "API token, read scope is enough (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
	fs.StringVar(token, "t", "", "shorthand for --token")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)
	*token = resolveToken(*token)

	if *appID == "" {
		fail("missing required flag: --app (or run this from a directory with a .railcast.json)")
	}
	if *outDir == "" {
		fail("missing required flag: --out <directory>")
	}
	if *token == "" {
		fail("missing required flag: --token (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}

	raw, data, err := doExport(*baseURL, *token, *appID, *filesURL)
	if err != nil {
		fail("could not export: %v", err)
	}
	if len(data.Releases) == 0 {
		fail("app %s has no releases to export", *appID)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fail("could not create %s: %v", *outDir, err)
	}

	label := data.App.Name
	if label == "" {
		label = *appID
	}
	fmt.Printf("Exporting %s (%s): %d release(s)\n\n", label, *appID, len(data.Releases))

	var totalBytes int64
	downloaded, skipped := 0, 0
	for i, r := range data.Releases {
		dest, err := exportDestination(*outDir, r.FileKey)
		if err != nil {
			fail("%v", err)
		}
		prefix := fmt.Sprintf("  [%d/%d] %s v%s (%s)", i+1, len(data.Releases), r.Channel, r.Version, humanSize(r.FileSize))

		if ok, _ := fileMatchesSHA256(dest, r.SHA256); ok {
			fmt.Printf("%s — already there, hash ok\n", prefix)
			skipped++
			totalBytes += r.FileSize
			continue
		}
		fmt.Printf("%s — downloading...", prefix)
		if err := downloadVerified(strings.TrimRight(data.PublicFileBaseURL, "/")+"/"+r.FileKey, dest, r.SHA256, r.FileSize); err != nil {
			fmt.Println()
			fail("%s: %v", r.FileKey, err)
		}
		fmt.Println(" ok")
		downloaded++
		totalBytes += r.FileSize
	}

	if err := os.WriteFile(filepath.Join(*outDir, "releases.json"), append(raw, '\n'), 0o644); err != nil {
		fail("could not write releases.json: %v", err)
	}

	var feeds []string
	channels := make([]string, 0, len(data.Appcasts))
	for ch := range data.Appcasts {
		channels = append(channels, ch)
	}
	sort.Strings(channels)
	for _, ch := range channels {
		name := "appcast.xml"
		if ch != "stable" {
			name = "appcast-" + ch + ".xml"
		}
		if err := os.WriteFile(filepath.Join(*outDir, name), []byte(data.Appcasts[ch]), 0o644); err != nil {
			fail("could not write %s: %v", name, err)
		}
		feeds = append(feeds, name)
	}

	fmt.Println()
	fmt.Printf("Done: %d downloaded, %d already present (%s total) → %s\n", downloaded, skipped, humanSize(totalBytes), *outDir)
	fmt.Println("  files/          every release file, same layout as on Railcast")
	fmt.Println("  releases.json   all releases with signatures, hashes, notes, yanked flags")
	for _, f := range feeds {
		fmt.Printf("  %-15s feed pointing at %s\n", f, strings.TrimRight(*filesURL, "/"))
	}
	if len(feeds) == 0 {
		fmt.Println("  (no appcast XML — pass --files-url <where you'll host files/> to get one)")
	}
	fmt.Println()
	fmt.Println("Installed copies keep polling the feed URL they shipped with. To move them,")
	fmt.Println("serve the new feed from the old URL (a redirect on your own domain works), or")
	fmt.Println("publish one last release whose SUFeedURL points at the new host.")
}

// doExport fetches GET /:appId/export. raw is the response body, kept so
// releases.json contains exactly what the server sent.
func doExport(baseURL, token, appID, filesURL string) (raw []byte, data *exportResponse, err error) {
	u := fmt.Sprintf("%s/%s/export", strings.TrimRight(baseURL, "/"), appID)
	if filesURL != "" {
		u += "?files_url=" + url.QueryEscape(filesURL)
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, nil, fmt.Errorf("no app with id %q", appID)
	case http.StatusForbidden:
		return nil, nil, fmt.Errorf("token doesn't have access to app %q", appID)
	case http.StatusBadRequest:
		return nil, nil, fmt.Errorf("server rejected the request: %s", strings.TrimSpace(string(body)))
	default:
		return nil, nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
	}

	var out exportResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, nil, fmt.Errorf("could not parse response: %w", err)
	}
	return body, &out, nil
}

// exportDestination maps a server-provided file_key to a path under
// <out>/files, refusing anything that would escape that directory.
func exportDestination(outDir, fileKey string) (string, error) {
	base := filepath.Join(outDir, "files")
	dest := filepath.Join(base, filepath.FromSlash(fileKey))
	rel, err := filepath.Rel(base, dest)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("refusing suspicious file key %q", fileKey)
	}
	return dest, nil
}

func fileMatchesSHA256(path, wantHex string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), wantHex), nil
}

// downloadVerified streams url to dest via a temp file and only moves it into
// place once size and sha256 match what the server recorded.
func downloadVerified(url, dest, wantSHA256 string, wantSize int64) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), resp.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if wantSize > 0 && n != wantSize {
		return fmt.Errorf("size mismatch: got %d bytes, expected %d", n, wantSize)
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, wantSHA256) {
		return fmt.Errorf("sha256 mismatch: got %s, expected %s", got, wantSHA256)
	}
	return os.Rename(tmp.Name(), dest)
}
