package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// TestSparkleKeyCompat runs against the real Sparkle command-line tools and is
// skipped unless RAILCAST_SPARKLE_BIN points at the directory holding
// generate_keys and sign_update (see .github/workflows/sparkle-compat.yml,
// which runs it on a macOS runner).
//
// It answers the question a unit test can't: does a key exported by Sparkle's
// generate_keys load through `railcast init --import-key`, and does it then
// produce exactly the signature Sparkle itself would? Ed25519 is
// deterministic, so "same key, same file" must give byte-identical signatures.
func TestSparkleKeyCompat(t *testing.T) {
	binDir := os.Getenv("RAILCAST_SPARKLE_BIN")
	if binDir == "" {
		t.Skip("RAILCAST_SPARKLE_BIN not set — needs Sparkle's generate_keys and sign_update")
	}
	generateKeys := filepath.Join(binDir, "generate_keys")
	signUpdate := filepath.Join(binDir, "sign_update")

	dir := t.TempDir()

	// 1. Let Sparkle create a key pair and tell us its public half.
	pubRe := regexp.MustCompile(`<string>([A-Za-z0-9+/]{43}=)</string>`)
	out := runSparkleTool(t, generateKeys)
	m := pubRe.FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("couldn't find SUPublicEDKey in generate_keys output:\n%s", out)
	}
	sparklePub := m[1]

	// 2. Export the private key the way a user migrating to Railcast would.
	keyFile := filepath.Join(dir, "sparkle_private_key")
	runSparkleTool(t, generateKeys, "-x", keyFile)
	raw, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatalf("generate_keys -x didn't write %s: %v", keyFile, err)
	}
	if decoded, err := base64.StdEncoding.DecodeString(string(trimSpace(raw))); err == nil {
		t.Logf("Sparkle's exported private key is %d bytes once decoded", len(decoded))
	} else {
		t.Logf("Sparkle's exported private key is not plain base64: %v", err)
	}

	// 3. Our importer must accept that file and derive the same public key.
	priv, err := loadImportKey(keyFile)
	if err != nil {
		t.Fatalf("`init --import-key` can't read Sparkle's export: %v", err)
	}
	ourPub := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	if ourPub != sparklePub {
		t.Fatalf("public key mismatch after import:\n  Sparkle: %s\n  Railcast: %s", sparklePub, ourPub)
	}

	// 4. Sparkle signs a file; we must be able to verify that signature, and
	// signing the same file ourselves must give the identical signature.
	data := make([]byte, 256*1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(dir, "MyApp-1.0.0.zip")
	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}

	sigRe := regexp.MustCompile(`sparkle:edSignature="([^"]+)"`)
	signOut := runSparkleTool(t, signUpdate, "--ed-key-file", keyFile, archive)
	sm := sigRe.FindStringSubmatch(signOut)
	if sm == nil {
		t.Fatalf("couldn't find sparkle:edSignature in sign_update output:\n%s", signOut)
	}
	sparkleSig, err := base64.StdEncoding.DecodeString(sm[1])
	if err != nil {
		t.Fatalf("Sparkle's signature isn't base64: %v", err)
	}
	if !ed25519.Verify(priv.Public().(ed25519.PublicKey), data, sparkleSig) {
		t.Fatal("Sparkle's own signature does not verify with the imported public key")
	}

	ourSig, err := signAndVerify(priv, data)
	if err != nil {
		t.Fatalf("signAndVerify: %v", err)
	}
	if ourSig != sm[1] {
		t.Fatalf("signatures differ for the same key and file:\n  Sparkle: %s\n  Railcast: %s", sm[1], ourSig)
	}
}

// runSparkleTool runs a Sparkle CLI tool with a timeout, so a keychain prompt
// on a headless runner fails the job instead of hanging it.
func runSparkleTool(t *testing.T, tool string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, tool, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v failed: %v\n%s", filepath.Base(tool), args, err, out)
	}
	return string(out)
}

func trimSpace(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r' || b[len(b)-1] == ' ') {
		b = b[:len(b)-1]
	}
	return b
}
