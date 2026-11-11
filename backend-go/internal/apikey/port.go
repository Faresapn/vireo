// Package apikey holds the use cases behind the Settings page: show the two
// Higgsfield keys masked, check them live, and replace one safely.
package apikey

import (
	"context"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Store reads and writes the key files.
type Store interface {
	// Read returns the slot's key, or "" when the file is missing or empty.
	Read(slot entity.KeySlot) (entity.APIKey, error)
	// ModTime returns when the slot's file last changed; ok is false if it is missing.
	ModTime(slot entity.KeySlot) (t time.Time, ok bool)
	// Path is the display path of the slot's file, e.g. "~/.higgsfield_key".
	Path(slot entity.KeySlot) string
	// Replace backs up the old key and writes the new one with owner-only permissions.
	Replace(slot entity.KeySlot, key entity.APIKey) error
}

// Checker asks Higgsfield whether a key is accepted, without spending credits.
type Checker interface {
	Check(ctx context.Context, key entity.APIKey) entity.KeyStatus
}
