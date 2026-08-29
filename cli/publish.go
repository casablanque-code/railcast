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
	fs := flag.NewFlagSet("publish", flag.ExitOnError)
	appID := fs.String("app", "", "app id (required)")
	filePath := fs.String("file", "", "path to the build archive/pkg to publish (required)")
	version := fs.String("version", "", "short version string, e.g. 1.2.0 (required)")
	buildNumber := fs.Int("build", 0, "monotonically increasing build number (required)")
	channel := fs.String("channel", "stable", "release channel: stable | beta")
	notes := fs.String("notes", "", "release notes (plain text or markdown)")
	notesFile := fs.String("notes-file", "", "path to a release notes file (overrides --notes)")
	keyPath := fs.String("key", "", "path to the private signing key file from 'railcast keygen' (required)")
	token := fs.String("token", os.Getenv("RAILCAST_TOKEN"), "API token (defaults to $RAILCAST_TOKEN)")
	baseURL := fs.String("base-url", os.Getenv("RAILCAST_BASE_URL"), "Railcast API base URL (defaults to $RAILCAST_BASE_URL)")
	fs.Parse(args)

	var missing []string
	if *appID == "" {
		missing = append(missing, "--app")
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
		missing = append(missing, "--key")
	}
	if *token == "" {
		missing = append(missing, "--token (or $RAILCAST_TOKEN)")
	}
	if *baseURL == "" {
		missing = append(missing, "--base-url (or $RAILCAST_BASE_URL)")
	}
	if len(missing) > 0 {
		fmt.Printf("missing required flags: %s\n", strings.Join(missing, ", "))
		os.Exit(1)
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

	fmt.Println("Uploading build...")
	upload, err := doUpload(*baseURL, *token, *appID, filename, fileBytes)
	if err != nil {
		fail("upload failed: %v", err)
	}
	fmt.Printf("  stored at: %s (%d bytes)\n", upload.FileKey, upload.FileSize)

	fmt.Println("Registering version...")
	result, err := doCreateVersion(createVersionRequest{
		BaseURL:     *baseURL,
		Token:       *token,
		AppID:       *appID,
		Version:     *version,
		BuildNumber: *buildNumber,
		Channel:     *channel,
		FileKey:     upload.FileKey,
		FileSize:    upload.FileSize,
		SHA256:      sha256Hex,
		Signature:   signatureB64,
		Notes:       *notes,
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
	// keygen prints both keys with labels; support either a bare base64
	// blob (one line) or the full keygen output (grab the last non-empty line).
	line := strings.TrimSpace(string(raw))
	if idx := strings.LastIndex(line, "\n"); idx != -1 {
		line = strings.TrimSpace(line[idx+1:])
	}
	decoded, err := base64.StdEncoding.DecodeString(line)
	if err != nil {
		return nil, fmt.Errorf("key file does not contain a valid base64 ed25519 private key: %w", err)
	}
	if len(decoded) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("unexpected key length %d (want %d) — did you point --key at the private key, not the public one?", len(decoded), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(decoded), nil
}

func doUpload(baseURL, token, appID, filename string, data []byte) (*uploadResponse, error) {
	url := fmt.Sprintf("%s/%s/upload/%s", strings.TrimRight(baseURL, "/"), appID, filename)
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
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
	BaseURL     string
	Token       string
	AppID       string
	Version     string
	BuildNumber int
	Channel     string
	FileKey     string
	FileSize    int64
	SHA256      string
	Signature   string
	Notes       string
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
