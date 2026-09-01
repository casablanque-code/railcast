package main

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

func TestColorEnabled_RespectsNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	if colorEnabled() {
		t.Fatal("expected colorEnabled() to be false when $NO_COLOR is set")
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("failed to create pipe: %v", err)
	}
	os.Stdout = w

	fn()

	w.Close()
	os.Stdout = old

	var buf bytes.Buffer
	io.Copy(&buf, r)
	return buf.String()
}

func TestPrintBox_PlainFallbackContainsAllLines(t *testing.T) {
	// os.Pipe() is not a character device, so colorEnabled() is false here
	// regardless of $NO_COLOR — this exercises the plain-output branch.
	out := captureStdout(t, func() {
		printBox("Test Title", "line one", "line two")
	})
	if !strings.Contains(out, "Test Title") {
		t.Fatalf("expected output to contain the title, got: %q", out)
	}
	if !strings.Contains(out, "line one") || !strings.Contains(out, "line two") {
		t.Fatalf("expected output to contain both lines, got: %q", out)
	}
}
