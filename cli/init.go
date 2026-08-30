package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

type createAppResponse struct {
	ID               string `json:"id"`
	SigningPublicKey string `json:"signing_public_key"`
}

type apiErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func cmdInit(args []string) {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	appID := fs.String("app", "", "app id to create, e.g. myapp (required)")
	token := fs.String("token", os.Getenv("RAILCAST_TOKEN"), "API token from the dashboard (defaults to $RAILCAST_TOKEN)")
	baseURL := fs.String("base-url", os.Getenv("RAILCAST_BASE_URL"), "Railcast API base URL (defaults to $RAILCAST_BASE_URL)")
	keyPath := fs.String("key", "", "where to save the private key (default: ./<app>.key)")
	fs.Parse(args)

	var missing []string
	if *appID == "" {
		missing = append(missing, "--app")
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

	if *keyPath == "" {
		*keyPath = *appID + ".key"
	}
	if _, err := os.Stat(*keyPath); err == nil {
		fail("refusing to overwrite existing file at %s — pass a different --key path", *keyPath)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fail("failed to generate key: %v", err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	privB64 := base64.StdEncoding.EncodeToString(priv)

	fmt.Printf("Creating %q and registering its signing key...\n", *appID)

	app, err := doCreateApp(*baseURL, *token, *appID, pubB64)
	if err != nil {
		fail("could not create the app: %v", err)
	}

	// Only write the key to disk once the app is actually registered —
	// no point leaving an orphaned key file behind on failure.
	if err := os.WriteFile(*keyPath, []byte(privB64+"\n"), 0600); err != nil {
		fail("app was created, but failed to save the private key locally: %v\nSave it now — it will not be shown again:\n%s", err, privB64)
	}

	fmt.Println()
	fmt.Println("Done. Keep this file safe — losing it means you can't publish updates for this app again:")
	fmt.Printf("  %s\n", *keyPath)
	fmt.Println()
	fmt.Println("Next: publish a build")
	fmt.Printf("  railcast publish --app %s --key %s --token <token> --version 1.0.0 --build 1 --file <path>\n", app.ID, *keyPath)
	fmt.Println()
	fmt.Println("Add these to your app's Info.plist:")
	fmt.Printf("  SUFeedURL: %s/%s/appcast.xml\n", strings.TrimRight(*baseURL, "/"), app.ID)
	fmt.Printf("  SUPublicEDKey: %s\n", app.SigningPublicKey)
}

func doCreateApp(baseURL, token, appID, publicKeyB64 string) (*createAppResponse, error) {
	payload, err := json.Marshal(map[string]string{
		"id":                appID,
		"signing_public_key": publicKeyB64,
	})
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/api/apps", strings.TrimRight(baseURL, "/"))
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusPaymentRequired {
		var apiErr apiErrorResponse
		if err := json.Unmarshal(body, &apiErr); err == nil && apiErr.Message != "" {
			return nil, fmt.Errorf("%s", apiErr.Message)
		}
		return nil, fmt.Errorf("your account doesn't have access yet")
	}
	if resp.StatusCode == http.StatusConflict {
		return nil, fmt.Errorf("an app called %q already exists — pick a different --app, or use its existing key with railcast publish", appID)
	}
	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
	}

	var out createAppResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("could not parse response: %w", err)
	}
	return &out, nil
}
