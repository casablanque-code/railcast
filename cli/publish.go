package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type uploadResponse struct {
	FileKey  string `json:"file_key"`
	FileSize int64  `json:"file_size"`
}

type createVersionResponse struct {
	AppID       string `json:"app_id"`
	Channel     string `json:"channel"`
	Version     string `json:"version"`
	BuildNumber int    `json:"build_number"`
	AppcastURL  string `json:"appcast_url"`
}

func cmdPublish(args []string) {
	cfg := loadProjectConfig()
	appDefault, keyDefault := "", ""
	if cfg != nil {
		appDefault, keyDefault = cfg.App, cfg.Key
	}

	fs := flag.NewFlagSet("publish", flag.ExitOnError)

	var appID, filePath, version, channel, notes, notesFile, keyPath, token, baseURL string
	var buildNumber, phasedRollout int
	var critical bool

	fs.StringVar(&appID, "app", appDefault, "app id from 'railcast init' (not the --app name you gave init) — defaults to .railcast.json in this directory")
	fs.StringVar(&appID, "a", appDefault, "shorthand for --app")

	fs.StringVar(&filePath, "file", "", "path to the build archive/pkg to publish (required)")
	fs.StringVar(&filePath, "f", "", "shorthand for --file")

	fs.StringVar(&version, "version", "", "short version string, e.g. 1.2.0 — only needed if it can't be auto-detected (see 'railcast publish --help')")
	fs.StringVar(&version, "v", "", "shorthand for --version")

	fs.IntVar(&buildNumber, "build", 0, "build number for this release — only needed if it can't be auto-detected (see 'railcast publish --help')")
	fs.IntVar(&buildNumber, "b", 0, "shorthand for --build")

	fs.StringVar(&channel, "channel", "stable", "release channel: stable | beta")
	fs.StringVar(&channel, "c", "stable", "shorthand for --channel")

	fs.StringVar(&notes, "notes", "", "release notes (plain text or markdown)")
	fs.StringVar(&notesFile, "notes-file", "", "path to a release notes file (overrides --notes)")
	fs.BoolVar(&critical, "critical", false, "mark this update as critical (Sparkle: sparkle:criticalUpdate)")
	fs.IntVar(&phasedRollout, "phased-rollout", 0, "phased rollout interval in seconds between install groups, 0 to disable (Sparkle: sparkle:phasedRolloutInterval)")

	fs.StringVar(&keyPath, "key", keyDefault, "path to the private signing key — defaults to the one from 'railcast init' in this directory")
	fs.StringVar(&keyPath, "k", keyDefault, "shorthand for --key")

	fs.StringVar(&token, "token", "", "API token (defaults to $RAILCAST_TOKEN, then a token saved by 'railcast init' in this directory)")
	fs.StringVar(&token, "t", "", "shorthand for --token")

	fs.StringVar(&baseURL, "base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	fs.Parse(args)
	baseURL = resolveBaseURL(baseURL)
	token = resolveToken(token)

	var missing []string
	if appID == "" {
		missing = append(missing, "--app/-a (or run 'railcast init' in this directory first)")
	}
	if filePath == "" {
		missing = append(missing, "--file/-f")
	}
	if keyPath == "" {
		missing = append(missing, "--key/-k (or run 'railcast init' in this directory first)")
	}
	if token == "" {
		missing = append(missing, "--token/-t (or $RAILCAST_TOKEN, or a token saved by 'railcast init')")
	}
	if len(missing) > 0 {
		fmt.Printf("missing required flags: %s\n", strings.Join(missing, ", "))
		fmt.Println()
		fmt.Println("Minimal example:")
		fmt.Println("  railcast publish -f MyApp-1.2.0.zip")
		fmt.Println("(runs from the same directory as 'railcast init' — --app/--key/--token are picked up automatically)")
		os.Exit(1)
	}

	if phasedRollout < 0 {
		fail("--phased-rollout must be 0 or a positive number of seconds")
	}
	if buildNumber < 0 {
		fail("--build/-b must be a positive integer, or omitted entirely to auto-assign the next one")
	}

	if notesFile != "" {
		b, err := os.ReadFile(notesFile)
		if err != nil {
			fail("failed to read notes file: %v", err)
		}
		notes = string(b)
	}

	fileBytes, err := os.ReadFile(filePath)
	if err != nil {
		fail("failed to read build file: %v", err)
	}

	privKey, err := loadPrivateKey(keyPath)
	if err != nil {
		fail("failed to load private key: %v", err)
	}

	sum := sha256.Sum256(fileBytes)
	sha256Hex := hex.EncodeToString(sum[:])

	signature := ed25519.Sign(privKey, fileBytes)
	signatureB64 := base64.StdEncoding.EncodeToString(signature)

	filename := filepath.Base(filePath)

	// Prefer the truth baked into the archive itself over anything typed by
	// hand — a zip's own Info.plist is what's actually going to run on
	// someone's Mac, so it can't drift from --version/--build the way a
	// separate counter (typed here, or auto-assigned server-side) could.
	isZip := strings.HasSuffix(strings.ToLower(filename), ".zip")
	var detected *bundleInfo
	var detectErr error
	if isZip {
		detected, detectErr = readBundleInfoFromZip(filePath)
	}

	// versionSource/buildSource exist purely to make the next printed block
	// legible: every value going into the release is labeled with where it
	// came from, so it's never a mystery why one publish needed --version/
	// --build typed out and another didn't.
	versionSource := "--version/-v"
	buildSource := "--build/-b"

	if version == "" {
		switch {
		case detected != nil:
			version = detected.ShortVersion
			versionSource = "detected from Info.plist"
		case isZip:
			fail(
				"this .zip doesn't have a readable <App>.app/Contents/Info.plist inside it (%v), "+
					"so the version can't be auto-detected.\n\n"+
					"This looks like a plain .zip (not a signed macOS .app bundle) — pass --version/-v "+
					"and --build/-b yourself, e.g.:\n"+
					"  railcast publish -f %s -v 1.2.0 -b 42\n\n"+
					"If this .zip does contain a .app bundle, double-check it's at the top level of the "+
					"archive (<App>.app/Contents/Info.plist), not nested in a subfolder.",
				detectErr, filename,
			)
		default:
			fail(
				"--version/-v is required for non-.zip archives (%s) — only .zip archives with a "+
					"macOS .app bundle inside can have their version auto-detected, e.g.:\n"+
					"  railcast publish -f %s -v 1.2.0 -b 42",
				filepath.Ext(filename), filename,
			)
		}
	}

	effectiveBuild := buildNumber
	if effectiveBuild == 0 {
		switch {
		case detected != nil:
			effectiveBuild = detected.BuildNumber
			buildSource = "detected from Info.plist"
		default:
			buildSource = "auto-assigned by Railcast"
		}
	}

	// One box, printed once, before anything touches the network: exactly
	// what's about to be published and why each value is what it is. This
	// is the single place meant to answer "what will happen if I run this
	// command" — no need to read output that scrolls by during upload.
	planLines := []string{
		fmt.Sprintf("file:    %s", filename),
		fmt.Sprintf("app:     %s", appID),
		fmt.Sprintf("channel: %s", channel),
		fmt.Sprintf("version: %s (%s)", version, versionSource),
	}
	if effectiveBuild > 0 {
		planLines = append(planLines, fmt.Sprintf("build:   %d (%s)", effectiveBuild, buildSource))
	} else {
		planLines = append(planLines, "build:   auto-assigned by Railcast on publish")
	}
	planLines = append(planLines, fmt.Sprintf("sha256:  %s", sha256Hex))
	if critical {
		planLines = append(planLines, "critical: yes")
	}
	if phasedRollout > 0 {
		planLines = append(planLines, fmt.Sprintf("phased rollout: every %ds", phasedRollout))
	}
	if isZip && detected == nil && detectErr != nil {
		planLines = append(planLines, fmt.Sprintf("note: version/build above are as given — Info.plist wasn't used (%v)", detectErr))
	}
	printBox("Publishing plan", planLines...)
	fmt.Println()

	fmt.Println("[1/2] Uploading build...")
	upload, err := doUpload(baseURL, token, appID, filename, sha256Hex, fileBytes)
	if err != nil {
		fail("upload failed: %v", err)
	}
	fmt.Printf("      stored at %s (%d bytes)\n", upload.FileKey, upload.FileSize)

	fmt.Println("[2/2] Registering version...")
	result, err := doCreateVersion(createVersionRequest{
		BaseURL:       baseURL,
		Token:         token,
		AppID:         appID,
		Version:       version,
		BuildNumber:   effectiveBuild,
		Channel:       channel,
		FileKey:       upload.FileKey,
		FileSize:      upload.FileSize,
		SHA256:        sha256Hex,
		Signature:     signatureB64,
		Notes:         notes,
		Critical:      critical,
		PhasedRollout: phasedRollout,
	})
	if err != nil {
		fail("registering version failed: %v", err)
	}

	fmt.Println()
	printBox(
		"Published",
		fmt.Sprintf("version: %s (build %d)", result.Version, result.BuildNumber),
		fmt.Sprintf("channel: %s", result.Channel),
		fmt.Sprintf("appcast: %s%s", baseURL, result.AppcastURL),
	)
}

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	lines := strings.Split(string(raw), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(line)
		if err != nil {
			continue // не base64 — просто текст пояснения, пропускаем
		}
		if len(decoded) == ed25519.PrivateKeySize {
			return ed25519.PrivateKey(decoded), nil
		}
	}

	return nil, fmt.Errorf("no valid ed25519 private key (base64, %d bytes) found in %s", ed25519.PrivateKeySize, path)
}

func doUpload(baseURL, token, appID, filename, sha256Hex string, data []byte) (*uploadResponse, error) {
	url := fmt.Sprintf("%s/%s/upload/%s", strings.TrimRight(baseURL, "/"), appID, filename)
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Sha256", sha256Hex)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf(
			"no app with id %q — --app takes the id from .railcast.json (or the one printed by 'railcast init'), not the name you gave --app at init time",
			appID,
		)
	}
	if resp.StatusCode == http.StatusConflict {
		return nil, fmt.Errorf(
			"%q was already published for this app, and filenames can't be reused once published (bumping --version or --build alone won't help). Rename the archive itself, e.g. include the version in the filename, and try again",
			filename,
		)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
	}

	var out uploadResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("could not parse upload response: %w", err)
	}
	if out.FileSize == 0 {
		out.FileSize = int64(len(data))
	}
	return &out, nil
}

type createVersionRequest struct {
	BaseURL       string
	Token         string
	AppID         string
	Version       string
	BuildNumber   int
	Channel       string
	FileKey       string
	FileSize      int64
	SHA256        string
	Signature     string
	Notes         string
	Critical      bool
	PhasedRollout int
}

func doCreateVersion(r createVersionRequest) (*createVersionResponse, error) {
	payload := map[string]interface{}{
		"version":       r.Version,
		"channel":       r.Channel,
		"file_key":      r.FileKey,
		"file_size":     r.FileSize,
		"sha256":        r.SHA256,
		"signature":     r.Signature,
		"release_notes": r.Notes,
	}
	// Omitted (not just zero/absent) when --build wasn't passed, so the
	// server can tell "auto-assign one" apart from "the build number is 0".
	if r.BuildNumber > 0 {
		payload["build_number"] = r.BuildNumber
	}
	if r.Critical {
		payload["critical"] = true
	}
	if r.PhasedRollout > 0 {
		payload["phased_rollout_interval"] = r.PhasedRollout
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/%s/versions", strings.TrimRight(r.BaseURL, "/"), r.AppID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf(
			"no app with id %q — --app takes the id from .railcast.json (or the one printed by 'railcast init'), not the name you gave --app at init time",
			r.AppID,
		)
	}
	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(respBody))
	}

	var out createVersionResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("could not parse response: %w", err)
	}
	return &out, nil
}

func fail(format string, args ...interface{}) {
	fmt.Printf(format+"\n", args...)
	os.Exit(1)
}
