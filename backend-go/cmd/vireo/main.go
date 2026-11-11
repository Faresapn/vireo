// Command vireo runs the studio's worker steps: ingest, screening, prompt
// writing, idea generation, renders, Drive archive and the autopilot. Each
// subcommand keeps the argv, stdout JSON and exit codes of the Node script it
// replaces, so scripts/*.mjs can delegate to it.
package main

import "os"

func main() {
	os.Exit(execute())
}
