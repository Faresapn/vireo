package entity_test

import (
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func TestDriveLabel(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"Denvo":              "Denvo",
		"(MP) KEPIN ANIMAL":  "KEPIN ANIMAL",
		"(mp)   Fishing":     "Fishing",
		`A/B:C*D?"E"<F>|G\H`: "ABCDEFGH",
		"  Kepin Anatoly  ":  "Kepin Anatoly",
		"(MP) ///":           "fallback-id",
	}
	for in, want := range tests {
		if got := entity.DriveLabel(in, "fallback-id"); got != want {
			t.Errorf("DriveLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDriveNamePrefix(t *testing.T) {
	t.Parallel()

	day := time.Date(2026, time.March, 5, 23, 0, 0, 0, time.UTC)
	if got := entity.DriveNamePrefix(day, "Denvo"); got != "05-03-2026_Denvo_" {
		t.Fatalf("got %q", got)
	}
}

func TestNextDriveName(t *testing.T) {
	t.Parallel()

	const p = "10-11-2026_Denvo_"

	tests := []struct {
		name string
		used []string
		want string
	}{
		{"first of the day", nil, p + "1.mp4"},
		{"after gaps uses highest", []string{p + "1.mp4", p + "4.mp4", p + "2.mp4"}, p + "5.mp4"},
		{"garbage counts as zero", []string{p + "x.mp4"}, p + "1.mp4"},
		{"other prefix ignored", []string{"10-11-2026_Denvo2_9.mp4"}, p + "1.mp4"},
		{"double digits", []string{p + "9.mp4", p + "10.mp4"}, p + "11.mp4"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := entity.NextDriveName(p, tt.used); got != tt.want {
				t.Fatalf("NextDriveName() = %q, want %q", got, tt.want)
			}
		})
	}
}
