package main

import (
	"os"
	"path/filepath"
	"strings"
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

func chdirTemp(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	oldWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get working directory: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("failed to chdir into temp dir: %v", err)
	}
	t.Cleanup(func() { os.Chdir(oldWd) })
	return dir
}

func TestResolveToken(t *testing.T) {
	t.Run("flag wins over everything", func(t *testing.T) {
		chdirTemp(t)
		t.Setenv("RAILCAST_TOKEN", "env-token")
		if err := saveToken("saved-token"); err != nil {
			t.Fatalf("saveToken: %v", err)
		}
		if got := resolveToken("flag-token"); got != "flag-token" {
			t.Fatalf("expected the flag value, got %q", got)
		}
	})

	t.Run("env wins over the saved file", func(t *testing.T) {
		chdirTemp(t)
		t.Setenv("RAILCAST_TOKEN", "env-token")
		if err := saveToken("saved-token"); err != nil {
			t.Fatalf("saveToken: %v", err)
		}
		if got := resolveToken(""); got != "env-token" {
			t.Fatalf("expected the env value, got %q", got)
		}
	})

	t.Run("falls back to the saved file", func(t *testing.T) {
		chdirTemp(t)
		t.Setenv("RAILCAST_TOKEN", "")
		if err := saveToken("saved-token"); err != nil {
			t.Fatalf("saveToken: %v", err)
		}
		if got := resolveToken(""); got != "saved-token" {
			t.Fatalf("expected the saved token, got %q", got)
		}
	})

	t.Run("empty string, not an error, when nothing is set", func(t *testing.T) {
		chdirTemp(t)
		t.Setenv("RAILCAST_TOKEN", "")
		if got := resolveToken(""); got != "" {
			t.Fatalf("expected empty string, got %q", got)
		}
	})
}

func TestSaveToken_RoundTripAndPermissions(t *testing.T) {
	dir := chdirTemp(t)

	if err := saveToken("my-secret-token"); err != nil {
		t.Fatalf("saveToken: %v", err)
	}

	if got := loadSavedToken(); got != "my-secret-token" {
		t.Fatalf("expected the round-tripped token, got %q", got)
	}

	info, err := os.Stat(filepath.Join(dir, tokenFilePath))
	if err != nil {
		t.Fatalf("expected %s to exist: %v", tokenFilePath, err)
	}
	// Same reasoning as the private key file: this holds a live credential
	// and should not be group/world readable.
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("expected 0600 permissions on %s, got %o", tokenFilePath, perm)
	}
}

func TestEnsureGitignored(t *testing.T) {
	t.Run("creates .gitignore when missing", func(t *testing.T) {
		dir := chdirTemp(t)
		if err := ensureGitignored("*.key", ".railcast.token"); err != nil {
			t.Fatalf("ensureGitignored: %v", err)
		}
		data, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
		if err != nil {
			t.Fatalf("expected .gitignore to be created: %v", err)
		}
		content := string(data)
		if !strings.Contains(content, "*.key") || !strings.Contains(content, ".railcast.token") {
			t.Fatalf("expected both patterns in .gitignore, got:\n%s", content)
		}
	})

	t.Run("appends only missing patterns, without duplicating existing ones", func(t *testing.T) {
		dir := chdirTemp(t)
		if err := os.WriteFile(".gitignore", []byte("node_modules\n*.key\n"), 0644); err != nil {
			t.Fatalf("seed .gitignore: %v", err)
		}
		if err := ensureGitignored("*.key", ".railcast.token"); err != nil {
			t.Fatalf("ensureGitignored: %v", err)
		}
		data, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
		if err != nil {
			t.Fatalf("read .gitignore: %v", err)
		}
		content := string(data)
		if strings.Count(content, "*.key") != 1 {
			t.Fatalf("expected *.key to appear exactly once, got:\n%s", content)
		}
		if !strings.Contains(content, ".railcast.token") {
			t.Fatalf("expected .railcast.token to be appended, got:\n%s", content)
		}
		if !strings.Contains(content, "node_modules") {
			t.Fatalf("expected the pre-existing node_modules entry to survive, got:\n%s", content)
		}
	})

	t.Run("is a no-op when every pattern is already present", func(t *testing.T) {
		chdirTemp(t)
		if err := os.WriteFile(".gitignore", []byte("*.key\n.railcast.token\n"), 0644); err != nil {
			t.Fatalf("seed .gitignore: %v", err)
		}
		before, err := os.Stat(".gitignore")
		if err != nil {
			t.Fatalf("stat before: %v", err)
		}
		if err := ensureGitignored("*.key", ".railcast.token"); err != nil {
			t.Fatalf("ensureGitignored: %v", err)
		}
		after, err := os.Stat(".gitignore")
		if err != nil {
			t.Fatalf("stat after: %v", err)
		}
		if before.Size() != after.Size() {
			t.Fatalf("expected .gitignore to be untouched, size changed from %d to %d", before.Size(), after.Size())
		}
	})
}
