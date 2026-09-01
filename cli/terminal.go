package main

import (
	"fmt"
	"os"
	"strings"
)

const (
	ansiReset  = "\033[0m"
	ansiBold   = "\033[1m"
	ansiCyan   = "\033[36m"
	ansiDim    = "\033[2m"
)

func colorEnabled() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// printBox prints a bordered block around the given lines. Falls back to a
// plain heading with no box-drawing or color when output isn't a real
// terminal (piped to a file, CI logs) or $NO_COLOR is set.
func printBox(title string, lines ...string) {
	if !colorEnabled() {
		fmt.Println(title)
		for _, l := range lines {
			fmt.Println("  " + l)
		}
		return
	}

	width := len(title)
	for _, l := range lines {
		if len(l) > width {
			width = len(l)
		}
	}
	width += 2

	top := "┌─ " + ansiBold + title + ansiReset + " " + strings.Repeat("─", max(0, width-len(title)-2)) + "┐"
	bottom := "└" + strings.Repeat("─", width+2) + "┘"

	fmt.Println(ansiDim + top + ansiReset)
	for _, l := range lines {
		fmt.Printf("%s│%s  %s%s%s\n", ansiDim, ansiReset, ansiCyan+l+ansiReset, strings.Repeat(" ", max(0, width-len(l))), ansiDim+"│"+ansiReset)
	}
	fmt.Println(ansiDim + bottom + ansiReset)
}
