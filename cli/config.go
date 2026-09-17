package main

import (
	"encoding/json"
	"os"
	"strings"
)

// This is a hosted service with one API — no reason to make every user type
// it out. --base-url / $RAILCAST_BASE_URL still override it for local dev
// against a non-production Worker.
const defaultBaseURL = "https://railcast.casablanque.com"

func resolveBaseURL(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if env := os.Getenv("RAILCAST_BASE_URL"); env != "" {
		return env
	}
	return defaultBaseURL
}

const projectConfigPath = ".railcast.json"

// Written by `railcast init` into the current directory so `railcast publish`
// doesn't need --app/--key repeated on every release. Contains no secret —
// the actual credential (the API token) is never stored here; see
// tokenFilePath below for where that lives instead. Keeping this file
// secret-free means projects that already committed it to git (reasonable,
// since historically it held nothing sensitive) don't suddenly leak a live
// token the next time init/publish touches it.
type projectConfig struct {
	App string `json:"app"`
	Key string `json:"key"`
}

func loadProjectConfig() *projectConfig {
	data, err := os.ReadFile(projectConfigPath)
	if err != nil {
		return nil
	}
	var cfg projectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	return &cfg
}

func saveProjectConfig(cfg projectConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(projectConfigPath, data, 0644)
}

// Where `railcast init` optionally saves the API token, mirroring how the
// private signing key is saved to <app>.key: a local, 0600 file instead of
// relying on the person to remember to `export RAILCAST_TOKEN=...`
// somewhere that survives a shell restart. Unlike .railcast.json, this file
// genuinely holds a live credential and must never be committed — see
// ensureGitignored.
const tokenFilePath = ".railcast.token"

// loadSavedToken returns "" (not an error) if the file doesn't exist or is
// unreadable — callers should treat a missing saved token exactly like an
// unset $RAILCAST_TOKEN, not a hard failure, since --token/$RAILCAST_TOKEN
// remain the primary way to supply one.
func loadSavedToken() string {
	data, err := os.ReadFile(tokenFilePath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func saveToken(token string) error {
	return os.WriteFile(tokenFilePath, []byte(token+"\n"), 0600)
}

// resolveToken applies the precedence every command shares: an explicit
// --token flag wins, then $RAILCAST_TOKEN (the documented "set once per
// shell" option), then whatever `railcast init` last saved to disk in this
// directory. Returns "" if none of the three produced anything.
func resolveToken(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if env := os.Getenv("RAILCAST_TOKEN"); env != "" {
		return env
	}
	return loadSavedToken()
}

// ensureGitignored makes sure each of the given patterns has its own line in
// ./.gitignore, creating the file if it doesn't exist yet and appending only
// the patterns that aren't already present (a plain line-presence check —
// not a full gitignore-syntax match, but enough to avoid duplicate entries
// across repeated `railcast init` runs). Failures here are deliberately
// non-fatal to the caller: not being able to update .gitignore shouldn't
// block creating the app or saving the key/token, it just means the person
// has to add the entries themselves.
func ensureGitignored(patterns ...string) error {
	existing, err := os.ReadFile(".gitignore")
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	lines := map[string]bool{}
	for _, line := range strings.Split(string(existing), "\n") {
		lines[strings.TrimSpace(line)] = true
	}

	var toAdd []string
	for _, p := range patterns {
		if !lines[p] {
			toAdd = append(toAdd, p)
		}
	}
	if len(toAdd) == 0 {
		return nil
	}

	f, err := os.OpenFile(".gitignore", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	// Only prefix a leading newline if the existing file doesn't already
	// end with one, so we don't glue a new entry onto the previous line.
	prefix := ""
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		prefix = "\n"
	}
	_, err = f.WriteString(prefix + strings.Join(toAdd, "\n") + "\n")
	return err
}
