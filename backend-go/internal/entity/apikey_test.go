package entity_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

const goodKey = "0123abcd-0000-4000-8000-0123456789ab:SecretSecret1234567890"

func TestParseAPIKey(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		raw     string
		wantErr error
	}{
		{"valid", goodKey, nil},
		{"surrounding whitespace", "  " + goodKey + "\n", nil},
		{"missing secret", "0123abcd-0000-4000-8000-0123456789ab", entity.ErrKeyFormat},
		{"short secret", "0123abcd-0000-4000-8000-0123456789ab:short", entity.ErrKeyFormat},
		{"not a uuid", "hello:SecretSecret1234567890", entity.ErrKeyFormat},
		{"empty", "", entity.ErrKeyFormat},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := entity.ParseAPIKey(tt.raw)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("ParseAPIKey(%q) error = %v, want %v", tt.raw, err, tt.wantErr)
			}
		})
	}
}

func TestAPIKeyNeverPrintsSecret(t *testing.T) {
	t.Parallel()

	k := entity.APIKey(goodKey)

	want := "0123abcd…7890"
	if got := k.Masked(); got != want {
		t.Fatalf("Masked() = %q, want %q", got, want)
	}

	if got := fmt.Sprintf("%v %s", k, k); got != want+" "+want {
		t.Fatalf("fmt output %q leaks or misformats the key", got)
	}

	if got := entity.APIKey("").Masked(); got != "" {
		t.Fatalf("empty key Masked() = %q, want empty", got)
	}
}
