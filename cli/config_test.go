package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveBaseURL(t *testing.T) {
	t.Run("flag wins", func(t *testing.T) {
		t.Setenv("RAILCAST_BASE_URL", "https://env.example.com")
		if got := resolveBaseURL("https://flag.example.com"); got != "https://flag.example.com" {
			t.Fatalf("expected the flag value, got %q", got)
		}
	})

	t.Run("env var wins over default", func(t *testing.T) {
		t.Setenv("RAILCAST_BASE_URL", "https://env.example.com")
		if got := resolveBaseURL(""); got != "https://env.example.com" {
			t.Fatalf("expected the env value, got %q", got)
		}
	})

	t.Run("falls back to the production default", func(t *testing.T) {
		t.Setenv("RAILCAST_BASE_URL", "")
		if got := resolveBaseURL(""); got != defaultBaseURL {
			t.Fatalf("expected %q, got %q", defaultBaseURL, got)
		}
	})
}

func TestProjectConfig_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	oldWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get working directory: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("failed to chdir into temp dir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(oldWd) })

	if got := loadProjectConfig(); got != nil {
		t.Fatalf("expected no config in an empty directory, got %+v", got)
	}

	cfg := projectConfig{App: "myapp", Key: "myapp.key"}
	if err := saveProjectConfig(cfg); err != nil {
		t.Fatalf("saveProjectConfig returned an error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, projectConfigPath)); err != nil {
		t.Fatalf("expected %s to exist: %v", projectConfigPath, err)
	}

	got := loadProjectConfig()
	if got == nil || got.App != "myapp" || got.Key != "myapp.key" {
		t.Fatalf("unexpected round-tripped config: %+v", got)
	}
}

func TestProjectConfig_MissingIsNilNotError(t *testing.T) {
	dir := t.TempDir()
	oldWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get working directory: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("failed to chdir into temp dir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(oldWd) })

	if got := loadProjectConfig(); got != nil {
		t.Fatalf("expected nil for a missing config file, got %+v", got)
	}
}
