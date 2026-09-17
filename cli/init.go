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
	Name             string `json:"name"`
	SigningPublicKey string `json:"signing_public_key"`
	BetaToken        string `json:"beta_token"`
}

func cmdInit(args []string) {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	// This is a local label only now — the server generates the real,
	// unguessable id used in the appcast URL. Kept as --app because it's
	// still what picks the default key filename and shows up in your
	// terminal; it does NOT need to be unique across all Railcast users.
	appName := fs.String("app", "", "a name for this app, e.g. myapp (required, local label only)")
	token := fs.String("token", "", "API token from the dashboard (defaults to $RAILCAST_TOKEN, then a token saved by an earlier 'railcast init' in this directory)")
	baseURL := fs.String("base-url", "", "Railcast API base URL (default: "+defaultBaseURL+", override with $RAILCAST_BASE_URL)")
	keyPath := fs.String("key", "", "where to save the private key (default: ./<app>.key)")
	initialBuild := fs.Int("initial-build", 0, "if this app already shipped builds outside Railcast (e.g. your own CFBundleVersion counter), set this to the highest one — auto-assigned build numbers will start above it, avoiding a number that's <= a build already installed somewhere")
	noSaveToken := fs.Bool("no-save-token", false, "don't write the token to .railcast.token — fall back to passing --token/$RAILCAST_TOKEN to every command instead")
	fs.Parse(args)
	*baseURL = resolveBaseURL(*baseURL)
	*token = resolveToken(*token)

	var missing []string
	if *appName == "" {
		missing = append(missing, "--app")
	}
	if *token == "" {
		missing = append(missing, "--token (or $RAILCAST_TOKEN)")
	}
	if len(missing) > 0 {
		fmt.Printf("missing required flags: %s\n", strings.Join(missing, ", "))
		os.Exit(1)
	}
	if *initialBuild < 0 {
		fail("--initial-build must be 0 or a positive integer")
	}

	if *keyPath == "" {
		*keyPath = *appName + ".key"
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

	fmt.Printf("Creating %q and registering its signing key...\n", *appName)

	app, err := doCreateApp(*baseURL, *token, *appName, pubB64, *initialBuild)
	if err != nil {
		fail("could not create the app: %v", err)
	}

	// Only write the key to disk once the app is actually registered —
	// no point leaving an orphaned key file behind on failure.
	if err := os.WriteFile(*keyPath, []byte(privB64+"\n"), 0600); err != nil {
		fail("app was created, but failed to save the private key locally: %v\nSave it now — it will not be shown again:\n%s", err, privB64)
	}

	// app.ID is the real, server-generated id — this is what publish uses
	// against the API, NOT the --app label.
	if err := saveProjectConfig(projectConfig{App: app.ID, Key: *keyPath}); err != nil {
		// Not fatal — the app and key both exist either way, this just
		// means 'railcast publish' will need --app/--key spelled out.
		fmt.Printf("Note: couldn't write %s (%v) — pass --app and --key to 'railcast publish' explicitly.\n", projectConfigPath, err)
	}

	tokenSaved := false
	if !*noSaveToken {
		if err := saveToken(*token); err != nil {
			fmt.Printf("Note: couldn't save the token to %s (%v) — pass --token or set $RAILCAST_TOKEN instead.\n", tokenFilePath, err)
		} else {
			tokenSaved = true
		}
	}

	// Both files hold a live credential (the private key; the token, if
	// saved) and must never end up committed. Best-effort — a failure here
	// doesn't affect anything that already succeeded above.
	gitignorePatterns := []string{"*.key"}
	if tokenSaved {
		gitignorePatterns = append(gitignorePatterns, tokenFilePath)
	}
	if err := ensureGitignored(gitignorePatterns...); err != nil {
		fmt.Printf("Note: couldn't update .gitignore (%v) — add %s yourself if this directory is a git repo.\n", err, strings.Join(gitignorePatterns, " and "))
	}

	fmt.Println()
	fmt.Println("Done. Keep this file safe — losing it means you can't publish updates for this app again:")
	fmt.Printf("  %s\n", *keyPath)
	fmt.Println()
	if *initialBuild > 0 {
		fmt.Printf("Auto-assigned build numbers on this app will start at %d.\n", *initialBuild+1)
		fmt.Println()
	}
	if tokenSaved {
		fmt.Printf("Token saved to %s (0600, gitignored) — 'railcast publish' and 'railcast list' in this directory will pick it up automatically, no --token needed.\n", tokenFilePath)
		fmt.Println("Losing this file just means regenerating a token in the dashboard — unlike the key above, it's not permanent.")
	} else {
		fmt.Println("Tip: export RAILCAST_TOKEN=" + *token + " in your shell so you don't have to pass --token every time.")
	}
	fmt.Println()
	fmt.Println("Next: publish a build from this directory")
	if tokenSaved {
		fmt.Println("  railcast publish --file <path>")
	} else {
		fmt.Println("  railcast publish --file <path> --token <token>")
	}
	fmt.Println()
	printBox(
		"Add these to your app's Info.plist",
		fmt.Sprintf("SUFeedURL: %s/%s/appcast.xml", strings.TrimRight(*baseURL, "/"), app.ID),
		fmt.Sprintf("SUPublicEDKey: %s", app.SigningPublicKey),
	)
	if app.BetaToken != "" {
		fmt.Println()
		printBox(
			"Beta channel feed (keep this URL private — the token is the only thing gating it)",
			fmt.Sprintf("%s/%s/appcast.xml?channel=beta&token=%s", strings.TrimRight(*baseURL, "/"), app.ID, app.BetaToken),
		)
	}
}

func doCreateApp(baseURL, token, name, publicKeyB64 string, initialBuild int) (*createAppResponse, error) {
	payload := map[string]interface{}{
		"name":                name,
		"signing_public_key": publicKeyB64,
	}
	if initialBuild > 0 {
		payload["initial_build_number"] = initialBuild
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/api/apps", strings.TrimRight(baseURL, "/"))
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
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

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, string(respBody))
	}

	var out createAppResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("could not parse response: %w", err)
	}
	return &out, nil
}
