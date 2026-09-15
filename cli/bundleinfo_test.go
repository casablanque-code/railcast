package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func writeTestZip(t *testing.T, entries map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "test.zip")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	w := zip.NewWriter(f)
	for name, content := range entries {
		fw, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return zipPath
}

// These two run everywhere (including CI on Linux) — pure zip-scanning
// logic, no PlistBuddy involved.

func TestReadBundleInfoFromZip_NoAppFound(t *testing.T) {
	zipPath := writeTestZip(t, map[string]string{
		"README.txt": "not an app",
	})

	if _, err := readBundleInfoFromZip(zipPath); err == nil {
		t.Fatal("expected an error when no .app/Contents/Info.plist is present, got nil")
	}
}

func TestReadBundleInfoFromZip_NotAZip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "not-a-zip.zip")
	if err := os.WriteFile(path, []byte("definitely not a zip file"), 0644); err != nil {
		t.Fatal(err)
	}

	if _, err := readBundleInfoFromZip(path); err == nil {
		t.Fatal("expected an error for a corrupt/non-zip file, got nil")
	}
}

// The rest need PlistBuddy, so they only actually run on macOS — CI (Linux)
// skips them rather than failing on missing tooling that isn't the point
// of the test.

func skipWithoutPlistBuddy(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("/usr/libexec/PlistBuddy"); err != nil {
		t.Skip("PlistBuddy not available on this machine (this test only runs on macOS)")
	}
}

const testInfoPlistXML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>2.0.0</string>
	<key>CFBundleVersion</key>
	<string>42</string>
</dict>
</plist>
`

func TestReadBundleInfoFromZip_ReadsRealPlist(t *testing.T) {
	skipWithoutPlistBuddy(t)

	zipPath := writeTestZip(t, map[string]string{
		"TestApp.app/Contents/Info.plist": testInfoPlistXML,
	})

	info, err := readBundleInfoFromZip(zipPath)
	if err != nil {
		t.Fatalf("readBundleInfoFromZip returned an error: %v", err)
	}
	if info.ShortVersion != "2.0.0" {
		t.Fatalf("unexpected ShortVersion: %q", info.ShortVersion)
	}
	if info.BuildNumber != 42 {
		t.Fatalf("unexpected BuildNumber: %d", info.BuildNumber)
	}
}

func TestReadBundleInfoFromZip_NonNumericBuildFails(t *testing.T) {
	skipWithoutPlistBuddy(t)

	plistXML := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>2.0.0</string>
	<key>CFBundleVersion</key>
	<string>not-a-number</string>
</dict>
</plist>
`

	zipPath := writeTestZip(t, map[string]string{
		"TestApp.app/Contents/Info.plist": plistXML,
	})

	if _, err := readBundleInfoFromZip(zipPath); err == nil {
		t.Fatal("expected an error for a non-numeric CFBundleVersion, got nil")
	}
}
