package entity

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	mpPrefix     = regexp.MustCompile(`(?i)^\(MP\)\s*`)
	badFileChars = regexp.MustCompile(`[\\/:*?"<>|]`)
)

// DriveLabel turns a persona name into the label used in Drive file names:
// "(MP) KEPIN ANIMAL" becomes "KEPIN ANIMAL", and characters that are not
// allowed in file names are dropped. An empty result falls back to fallback.
func DriveLabel(name, fallback string) string {
	l := strings.TrimSpace(badFileChars.ReplaceAllString(mpPrefix.ReplaceAllString(name, ""), ""))
	if l == "" {
		return fallback
	}

	return l
}

// DriveNamePrefix is "DD-MM-YYYY_<label>_" for day. "/" cannot appear in a
// file name, so the date uses "-".
func DriveNamePrefix(day time.Time, label string) string {
	return fmt.Sprintf("%02d-%02d-%04d_%s_", day.Day(), int(day.Month()), day.Year(), label)
}

// NextDriveName returns prefix + n + ".mp4", where n is one more than the
// highest batch number among used names that share prefix. Names whose number
// does not parse count as 0, as in the original Node script.
func NextDriveName(prefix string, used []string) string {
	highest := 0

	for _, u := range used {
		rest, ok := strings.CutPrefix(u, prefix)
		if !ok {
			continue
		}

		n, err := strconv.Atoi(strings.TrimSuffix(rest, ".mp4"))
		if err == nil && n > highest {
			highest = n
		}
	}

	return prefix + strconv.Itoa(highest+1) + ".mp4"
}
