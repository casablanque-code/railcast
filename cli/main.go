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
		printHelp()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "keygen":
		cmdKeygen()
	case "init":
		cmdInit(os.Args[2:])
	case "publish":
		cmdPublish(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("railcast", version)
	case "help", "--help", "-h":
		printHelp()
	default:
		fmt.Printf("unknown command: %s\n\n", os.Args[1])
		printHelp()
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Println(`railcast — hosted appcast feeds and update delivery for Sparkle

Usage:
  railcast init --app <id> --token <token>
      Create an app and generate its signing key. Start here.

  railcast publish --version <v> --build <n> --file <path> --token <token>
      Sign and publish a build. Reads --app/--key from .railcast.json
      automatically if you run it from the same directory as 'init'.

  railcast keygen        Generate a signing key without creating an app
  railcast version        Print the CLI version
  railcast help           Show this message

Every command needs a token — get one at https://railcast.casablanque.com/dashboard
Set it once and skip retyping --token: export RAILCAST_TOKEN=<token>

Run 'railcast <command> --help' for a command's full flag list.`)
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
