package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
)

// Set at build time via -ldflags "-X main.version=...". Defaults to "dev"
// for local `go build`.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: railcast <command>")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "keygen":
		cmdKeygen()
	case "publish":
		cmdPublish(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("railcast", version)
	default:
		fmt.Printf("unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func cmdKeygen() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Println("failed to generate key:", err)
		os.Exit(1)
	}

	pubB64 := base64.StdEncoding.EncodeToString(pub)
	privB64 := base64.StdEncoding.EncodeToString(priv)

	fmt.Println("Public key (save this in Railcast when creating the app):")
	fmt.Println(pubB64)
	fmt.Println()
	fmt.Println("Private key (keep this local, NEVER share it — losing it means you can't publish anymore):")
	fmt.Println(privB64)
	fmt.Println()
	fmt.Println("Recommended: save the private key to a file, e.g.:")
	fmt.Println("  railcast keygen | tee ~/.railcast/myapp.key")
}
