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
	case "list", "ls":
		cmdList(os.Args[2:])
	case "cleanup":
		cmdCleanup(os.Args[2:])
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

The whole flow, start to finish:
  1. railcast init --app <name> --token <token>     (once per app)
  2. railcast publish -f <path>                      (every release)

Usage:
  railcast init --app <name> --token <token>
      Create an app and generate its signing key. Start here — this writes
      .railcast.json and .railcast.token so every later command in this
      directory just works with no flags.

  railcast publish -f <path>
      Sign and publish a build. --app/--key/--token are read from
      .railcast.json / .railcast.token automatically if you ran 'init' in
      this directory — you normally only need -f.

      Two situations, handled differently:
        • Your archive is a .zip containing a signed .app bundle
          → -v/--version and -b/--build are detected automatically from
            the bundle's own Info.plist. Don't pass them; just:
              railcast publish -f MyApp-1.2.0.zip
        • Your archive is anything else (.dmg/.pkg, or a plain .zip with
          no .app bundle inside)
          → nothing to detect, so you must pass -v and -b yourself:
              railcast publish -f MyApp.pkg -v 1.2.0 -b 42
      Either way, 'railcast publish' prints a "Publishing plan" box before
      touching the network, showing every value it's about to use and
      where each one came from — check that first if anything looks off.

      Add --critical or --phased-rollout <seconds> for Sparkle's staged
      rollout controls — see 'railcast publish --help' for the full list.

  railcast list (or: ls) --token <token>
      Show published apps and their releases. With no --app, lists every
      app your token can see; with --app (or a .railcast.json in this
      directory), shows just that app's releases. Add --json for
      machine-readable output.

  railcast cleanup --app <id>
      Delete releases that have already fallen out of the appcast's
      history window (the last 10 builds per channel — older ones aren't
      served to any client anyway). Shows what would be deleted and asks
      for confirmation; pass --yes to skip the prompt (for CI) or
      --dry-run to only preview.

  railcast keygen        Generate a signing key without creating an app
  railcast version        Print the CLI version
  railcast help           Show this message

Most publish flags have a one-letter shorthand: -f (--file), -v (--version),
-b (--build), -a (--app), -k (--key), -t (--token), -c (--channel).

Every command needs a token — get one at https://railcast.casablanque.com/dashboard
'railcast init' saves it to .railcast.token (gitignored) in this directory, so
publish/list pick it up automatically — no need to export $RAILCAST_TOKEN yourself
unless you pass --no-save-token to init.

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
