package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func writeTempFile(t *testing.T, contents string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.key")
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatalf("failed to write temp key file: %v", err)
	}
	return path
}

func TestLoadPrivateKey_SingleLineBase64(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	_ = pub

	encoded := base64.StdEncoding.EncodeToString(priv)
	path := writeTempFile(t, encoded)

	got, err := loadPrivateKey(path)
	if err != nil {
		t.Fatalf("loadPrivateKey returned an error: %v", err)
	}
	if !got.Equal(priv) {
		t.Fatal("loaded private key does not match the original")
	}
}

func TestLoadPrivateKey_KeygenStyleMultiLineOutput(t *testing.T) {
	// Mirrors what `railcast keygen` actually prints: a labeled public key
	// line, then the private key alone on the last line.
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(priv)
	contents := "public key: some-fake-public-key-line\n" + encoded + "\n"
	path := writeTempFile(t, contents)

	got, err := loadPrivateKey(path)
	if err != nil {
		t.Fatalf("loadPrivateKey returned an error: %v", err)
	}
	if !got.Equal(priv) {
		t.Fatal("loaded private key does not match the original")
	}
}

func TestLoadPrivateKey_NoValidKeyInFile(t *testing.T) {
	path := writeTempFile(t, "not valid base64!!!\njust some other text\n")
	if _, err := loadPrivateKey(path); err == nil {
		t.Fatal("expected an error when no line decodes to a private key, got nil")
	}
}

func TestLoadPrivateKey_WrongLength(t *testing.T) {
	// A public key (32 bytes) is valid base64 but the wrong length for a
	// private key (64 bytes) — this is the classic "pasted the wrong key" mistake.
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(pub)
	path := writeTempFile(t, encoded)

	_, err = loadPrivateKey(path)
	if err == nil {
		t.Fatal("expected an error for a wrong-length key, got nil")
	}
}

func TestLoadPrivateKey_FindsKeyAmongTrailingHintText(t *testing.T) {
	// Mirrors the actual output of `railcast keygen | tee key-file`: labels,
	// the public key, the private key, and a usage hint AFTER the private key.
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(priv)
	contents := "Public key (save this in Railcast when creating the app):\nsome-fake-public-key\n\n" +
		"Private key (keep this local, NEVER share it):\n" + encoded + "\n\n" +
		"Recommended: save the private key to a file, e.g.:\n  railcast keygen | tee ~/.railcast/myapp.key\n"
	path := writeTempFile(t, contents)

	got, err := loadPrivateKey(path)
	if err != nil {
		t.Fatalf("loadPrivateKey returned an error: %v", err)
	}
	if !got.Equal(priv) {
		t.Fatal("loaded private key does not match the original")
	}
}

func TestLoadPrivateKey_MissingFile(t *testing.T) {
	if _, err := loadPrivateKey("/nonexistent/path/to/key"); err == nil {
		t.Fatal("expected an error for a missing file, got nil")
	}
}
