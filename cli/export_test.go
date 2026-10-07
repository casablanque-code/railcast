package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sha(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestExportDestination_StaysInsideFilesDir(t *testing.T) {
	out := t.TempDir()
	good, err := exportDestination(out, "app1/MyApp-1.0.zip")
	if err != nil || good != filepath.Join(out, "files", "app1", "MyApp-1.0.zip") {
		t.Fatalf("unexpected result %q, %v", good, err)
	}
	for _, bad := range []string{"../evil.zip", "app1/../../evil.zip", "", "."} {
		if _, err := exportDestination(out, bad); err == nil {
			t.Fatalf("expected %q to be refused", bad)
		}
	}
}

func TestDownloadVerified_AcceptsMatchingFile(t *testing.T) {
	body := []byte("release bytes")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "files", "app", "a.zip")
	if err := downloadVerified(srv.URL+"/app/a.zip", dest, sha(body), int64(len(body))); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, _ := fileMatchesSHA256(dest, sha(body)); !ok {
		t.Fatal("downloaded file doesn't match its hash")
	}
}

func TestDownloadVerified_RejectsTamperedOrTruncatedFilesAndLeavesNothing(t *testing.T) {
	body := []byte("release bytes")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "a.zip")

	err := downloadVerified(srv.URL, dest, sha([]byte("something else")), int64(len(body)))
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected a sha256 mismatch, got %v", err)
	}
	err = downloadVerified(srv.URL, dest, sha(body), int64(len(body))+5)
	if err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected a size mismatch, got %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("failed downloads must not leave files behind, found %d", len(entries))
	}
}

func TestDownloadVerified_FailsOnHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	if err := downloadVerified(srv.URL, filepath.Join(t.TempDir(), "a.zip"), "00", 0); err == nil {
		t.Fatal("expected an error for a 404")
	}
}

func TestDoExport_ParsesResponseAndPassesFilesURL(t *testing.T) {
	var gotQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery, gotAuth = r.URL.RawQuery, r.Header.Get("Authorization")
		w.Write([]byte(`{"app":{"id":"a1","name":"My App","signing_public_key":"PUB"},"public_file_base_url":"https://dl.example","releases":[{"id":1,"channel":"stable","version":"1.0.0","build_number":1,"file_key":"a1/x.zip","file_size":3,"sha256":"ab","yanked":0}],"appcasts":{"stable":"<rss/>"}}`))
	}))
	defer srv.Close()

	raw, data, err := doExport(srv.URL, "tok", "a1", "https://updates.example.com/files")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer tok" || !strings.Contains(gotQuery, "files_url=https%3A%2F%2Fupdates.example.com%2Ffiles") {
		t.Fatalf("unexpected request: auth %q query %q", gotAuth, gotQuery)
	}
	if data.App.Name != "My App" || len(data.Releases) != 1 || data.Appcasts["stable"] != "<rss/>" || len(raw) == 0 {
		t.Fatalf("unexpected parse: %+v", data)
	}
}

func TestDoExport_MapsErrors(t *testing.T) {
	for status, want := range map[int]string{404: "no app", 403: "access", 400: "rejected"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
		_, _, err := doExport(srv.URL, "tok", "a1", "")
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("status %d: expected error containing %q, got %v", status, want, err)
		}
	}
}
