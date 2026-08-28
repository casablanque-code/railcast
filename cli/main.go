package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: railcast <command>")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "keygen":
		cmdKeygen()
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

	fmt.Println("Public key (сохрани это в Railcast при создании app):")
	fmt.Println(pubB64)
	fmt.Println()
	fmt.Println("Private key (храни локально, НИКОГДА никому не показывай, потеря = не сможешь публиковать):")
	fmt.Println(privB64)
	fmt.Println()
	fmt.Println("Рекомендуется сохранить приватный ключ в файл, например:")
	fmt.Println("  railcast keygen > ~/.railcast/demoapp.key")
}
