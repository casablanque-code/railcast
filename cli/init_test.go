package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDoCreateApp_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/apps" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Fatalf("unexpected Authorization header: %q", got)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}
		if body["name"] != "myapp" || body["signing_public_key"] != "pubkey123" {
			t.Fatalf("unexpected request body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(createAppResponse{ID: "aZ3kQ9mN2pRt", Name: "myapp", SigningPublicKey: "pubkey123"})
	}))
	defer srv.Close()

	app, err := doCreateApp(srv.URL, "test-token", "myapp", "pubkey123", 0)
	if err != nil {
		t.Fatalf("doCreateApp returned an error: %v", err)
	}
	if app.ID != "aZ3kQ9mN2pRt" || app.SigningPublicKey != "pubkey123" {
		t.Fatalf("unexpected response: %+v", app)
	}
}

func TestDoCreateApp_WithInitialBuild(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}
		got, ok := body["initial_build_number"]
		if !ok {
			t.Fatalf("expected initial_build_number in request body, got: %+v", body)
		}
		if got != float64(999) {
			t.Fatalf("unexpected initial_build_number: %v", got)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(createAppResponse{ID: "aZ3kQ9mN2pRt", Name: "myapp", SigningPublicKey: "pubkey123"})
	}))
	defer srv.Close()

	if _, err := doCreateApp(srv.URL, "test-token", "myapp", "pubkey123", 999); err != nil {
		t.Fatalf("doCreateApp returned an error: %v", err)
	}
}

func TestDoCreateApp_OmitsInitialBuildWhenZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}
		if _, ok := body["initial_build_number"]; ok {
			t.Fatalf("expected initial_build_number to be omitted, got: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(createAppResponse{ID: "aZ3kQ9mN2pRt", Name: "myapp", SigningPublicKey: "pubkey123"})
	}))
	defer srv.Close()

	if _, err := doCreateApp(srv.URL, "test-token", "myapp", "pubkey123", 0); err != nil {
		t.Fatalf("doCreateApp returned an error: %v", err)
	}
}

func TestDoCreateApp_UnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("boom"))
	}))
	defer srv.Close()

	_, err := doCreateApp(srv.URL, "test-token", "myapp", "pubkey123", 0)
	if err == nil {
		t.Fatal("expected an error for a 500 response, got nil")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected the status code in the error, got: %v", err)
	}
}

// No early-access gate exists anymore — a 402 (or any other non-201) isn't
// special-cased, it just falls through to the generic "server returned N"
// error like any other unexpected status.
func TestDoCreateApp_402IsNotSpecialCased(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		w.Write([]byte("not used for anything anymore"))
	}))
	defer srv.Close()

	_, err := doCreateApp(srv.URL, "test-token", "myapp", "pubkey123", 0)
	if err == nil {
		t.Fatal("expected an error for a 402 response, got nil")
	}
	if !strings.Contains(err.Error(), "402") {
		t.Fatalf("expected the generic status-code error, got: %v", err)
	}
}
