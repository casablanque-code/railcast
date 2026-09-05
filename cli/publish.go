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
	appID := fs.String("app", appDefault, "app id from 'railcast init' (not the --app name you gave init) — defaults to .railcast.json in this directory")
	filePath := fs.String("file", "", "path to the build archive/pkg to publish (required)")
	version := fs.String("version", "", "short version string, e.g. 1.2.0 (required)")
	buildNumber := fs.Int("build", 0, "monotonically increasing build number (required)")
	channel := fs.String("channel", "stable", "release channel: stable | beta")
	notes := fs.String("notes", "", "release notes (plain text or markdown)")
	notesFile := fs.String("notes-file", "", "path to a release notes file (overrides --notes)")
	critical := fs.Bool("critical", false, "mark this update as critical (Sparkle: sparkle:criticalUpdate)")
	phasedRollout := fs.Int("phased-rollout", 0, "phased rollout interval in seconds between install groups, 0 to disable (Sparkle: sparkle:phasedRolloutInterval)")
	keyPath := fs.String("key", keyDefault, "path to the private signing key — defaults to the one from 'railcast init' in this directory")
	token := fs.String("token", os.Getenv("RAILCAST_TOKEN"), "API token (defaults to $RAILCAST_TOKEN)")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)

	var missing []string
	if *appID == "" {
		missing = append(missing, "--app (or run 'railcast init' in this directory first)")
	}
	if *filePath == "" {
		missing = append(missing, "--file")
	}
	if *version == "" {
		missing = append(missing, "--version")
	}
	if *buildNumber <= 0 {
		missing = append(missing, "--build")
	}
	if *keyPath == "" {
		missing = append(missing, "--key (or run 'railcast init' in this directory first)")
	}
	if *token == "" {
		missing = append(missing, "--token (or $RAILCAST_TOKEN)")
	}
	if len(missing) > 0 {
		fmt.Printf("missing required flags: %s\n", strings.Join(missing, ", "))
		os.Exit(1)
	}

	if *phasedRollout < 0 {
		fail("--phased-rollout must be 0 or a positive number of seconds")
	}

	if *notesFile != "" {
		b, err := os.ReadFile(*notesFile)
		if err != nil {
			fail("failed to read notes file: %v", err)
		}
		*notes = string(b)
	}

	fileBytes, err := os.ReadFile(*filePath)
	if err != nil {
		fail("failed to read build file: %v", err)
	}

	privKey, err := loadPrivateKey(*keyPath)
	if err != nil {
		fail("failed to load private key: %v", err)
	}

	sum := sha256.Sum256(fileBytes)
	sha256Hex := hex.EncodeToString(sum[:])

	signature := ed25519.Sign(privKey, fileBytes)
	signatureB64 := base64.StdEncoding.EncodeToString(signature)

	filename := filepath.Base(*filePath)

	fmt.Printf("Publishing %s v%s (build %d) on channel %q...\n", filename, *version, *buildNumber, *channel)
	fmt.Printf("  sha256: %s\n", sha256Hex)
	if *critical {
		fmt.Println("  critical: yes")
	}
	if *phasedRollout > 0 {
		fmt.Printf("  phased rollout: every %ds\n", *phasedRollout)
	}

	fmt.Println("Uploading build...")
	upload, err := doUpload(*baseURL, *token, *appID, filename, sha256Hex, fileBytes)
	if err != nil {
		fail("upload failed: %v", err)
	}
	fmt.Printf("  stored at: %s (%d bytes)\n", upload.FileKey, upload.FileSize)

	fmt.Println("Registering version...")
	result, err := doCreateVersion(createVersionRequest{
		BaseURL:       *baseURL,
		Token:         *token,
		AppID:         *appID,
		Version:       *version,
		BuildNumber:   *buildNumber,
		Channel:       *channel,
		FileKey:       upload.FileKey,
		FileSize:      upload.FileSize,
		SHA256:        sha256Hex,
		Signature:     signatureB64,
		Notes:         *notes,
		Critical:      *critical,
		PhasedRollout: *phasedRollout,
	})
	if err != nil {
		fail("registering version failed: %v", err)
	}

	fmt.Println()
	fmt.Println("Published.")
	fmt.Printf("  appcast: %s%s\n", *baseURL, result.AppcastURL)
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
			"%q was already published under this app — rename the file or bump the version/build so it gets a new filename",
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
		"build_number":  r.BuildNumber,
		"channel":       r.Channel,
		"file_key":      r.FileKey,
		"file_size":     r.FileSize,
		"sha256":        r.SHA256,
		"signature":     r.Signature,
		"release_notes": r.Notes,
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
