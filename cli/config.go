package main

import (
	"encoding/json"
	"os"
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
// the token still only ever comes from --token or $RAILCAST_TOKEN.
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
