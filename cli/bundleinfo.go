package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// bundleInfo holds what we can read straight from the shipped .app's own
// Info.plist inside the archive being published — the single source of
// truth for what's actually going to run on someone's Mac. Deriving
// --version/--build from here instead of a separate Railcast-side counter
// means there's nothing to keep in sync by hand, and nothing that can
// silently drift from what's really installed.
type bundleInfo struct {
	ShortVersion string // CFBundleShortVersionString, e.g. "2.0.0"
	BuildNumber  int    // CFBundleVersion, e.g. "42"
}

// readBundleInfoFromZip looks for a top-level "<Name>.app/Contents/Info.plist"
// inside a zip archive and reads CFBundleShortVersionString/CFBundleVersion
// out of it via PlistBuddy — bundled with macOS, and handles both XML and
// binary-format plists transparently, so no plist-parsing library is needed
// here at all.
func readBundleInfoFromZip(zipPath string) (*bundleInfo, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, fmt.Errorf("not a zip archive: %w", err)
	}
	defer r.Close()

	var plistEntry *zip.File
	for _, f := range r.File {
		if strings.HasSuffix(f.Name, ".app/Contents/Info.plist") {
			plistEntry = f
			break
		}
	}
	if plistEntry == nil {
		return nil, fmt.Errorf("no <App>.app/Contents/Info.plist found inside the archive")
	}

	rc, err := plistEntry.Open()
	if err != nil {
		return nil, fmt.Errorf("could not read Info.plist from archive: %w", err)
	}
	defer rc.Close()

	tmp, err := os.CreateTemp("", "railcast-infoplist-*.plist")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())

	if _, err := io.Copy(tmp, rc); err != nil {
		tmp.Close()
		return nil, fmt.Errorf("could not extract Info.plist: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}

	shortVersion, err := readPlistValue(tmp.Name(), "CFBundleShortVersionString")
	if err != nil {
		return nil, err
	}
	buildString, err := readPlistValue(tmp.Name(), "CFBundleVersion")
	if err != nil {
		return nil, err
	}

	build, err := strconv.Atoi(strings.TrimSpace(buildString))
	if err != nil {
		return nil, fmt.Errorf(
			"CFBundleVersion in Info.plist is %q, not a plain integer — Railcast's build ordering needs a numeric CFBundleVersion",
			strings.TrimSpace(buildString),
		)
	}

	return &bundleInfo{ShortVersion: strings.TrimSpace(shortVersion), BuildNumber: build}, nil
}

func readPlistValue(plistPath, key string) (string, error) {
	cmd := exec.Command("/usr/libexec/PlistBuddy", "-c", fmt.Sprintf("Print :%s", key), plistPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf(
			"could not read %s from Info.plist (this only works when running on macOS, where PlistBuddy is available): %s",
			key, strings.TrimSpace(string(out)),
		)
	}
	return string(out), nil
}
