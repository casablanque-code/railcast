package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckRedirectTarget(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`<?xml version="1.0"?><rss version="2.0"><channel><item><title>1.0</title></item></channel></rss>`))
	}))
	defer good.Close()
	if err := checkRedirectTarget(good.URL); err != nil {
		t.Fatalf("a real-looking appcast was rejected: %v", err)
	}

	notFeed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<html>hi</html>")) }))
	defer notFeed.Close()
	if err := checkRedirectTarget(notFeed.URL); err == nil || !strings.Contains(err.Error(), "appcast") {
		t.Fatalf("expected a not-an-appcast error, got %v", err)
	}

	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<rss></rss>")) }))
	defer empty.Close()
	if err := checkRedirectTarget(empty.URL); err == nil {
		t.Fatal("a feed with no <item> must be rejected")
	}

	missing := httptest.NewServer(http.NotFoundHandler())
	defer missing.Close()
	if err := checkRedirectTarget(missing.URL); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected an HTTP 404 error, got %v", err)
	}

	if err := checkRedirectTarget("http://127.0.0.1:1/appcast.xml"); err == nil {
		t.Fatal("an unreachable target must be rejected")
	}
}

func TestDoSetFeedRedirect_SendsURLOrNullAndMapsErrors(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	var gotBody map[string]interface{}
	status := http.StatusOK
	respBody := `{"feed_redirect_url":null}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		gotBody = map[string]interface{}{}
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(status)
		w.Write([]byte(respBody))
	}))
	defer srv.Close()

	target := "https://updates.example.com/appcast.xml"
	if err := doSetFeedRedirect(srv.URL, "tok", "app1", &target); err != nil {
		t.Fatal(err)
	}
	if gotMethod != "PUT" || gotPath != "/app1/feed-redirect" || gotAuth != "Bearer tok" || gotBody["url"] != target {
		t.Fatalf("unexpected request: %s %s %q %v", gotMethod, gotPath, gotAuth, gotBody)
	}

	if err := doSetFeedRedirect(srv.URL, "tok", "app1", nil); err != nil {
		t.Fatal(err)
	}
	if v, ok := gotBody["url"]; !ok || v != nil {
		t.Fatalf("clearing must send an explicit null, got %v", gotBody)
	}

	status, respBody = http.StatusBadRequest, `{"error":"invalid_input","message":"url must be https"}`
	if err := doSetFeedRedirect(srv.URL, "tok", "app1", &target); err == nil || !strings.Contains(err.Error(), "must be https") {
		t.Fatalf("expected the server's message, got %v", err)
	}
	status, respBody = http.StatusForbidden, ""
	if err := doSetFeedRedirect(srv.URL, "tok", "app1", &target); err == nil || !strings.Contains(err.Error(), "publish scope") {
		t.Fatalf("expected a scope hint, got %v", err)
	}
}
