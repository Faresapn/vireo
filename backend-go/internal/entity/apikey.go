package entity

import (
	"errors"
	"regexp"
	"strings"
	"time"
)

// KeySlot names one of the two Higgsfield API keys.
type KeySlot string

// The two key slots.
const (
	SlotWan      KeySlot = "wan"      // Wan 3.0 Prime, Wan, Genjutsu Light
	SlotSeedance KeySlot = "seedance" // Seedance 2.5, Genjutsu
)

// Slots lists every slot in display order.
var Slots = []KeySlot{SlotWan, SlotSeedance}

// Valid reports whether s is a known slot.
func (s KeySlot) Valid() bool { return s == SlotWan || s == SlotSeedance }

// Engines is the human label of the engines a slot pays for.
func (s KeySlot) Engines() string {
	switch s {
	case SlotWan:
		return "Wan 3.0 Prime, Wan, Genjutsu Light"
	case SlotSeedance:
		return "Seedance 2.5, Genjutsu"
	}

	return ""
}

// KeyStatus is the outcome of checking a key against Higgsfield.
type KeyStatus string

// Possible check outcomes.
const (
	KeyValid   KeyStatus = "valid"
	KeyInvalid KeyStatus = "invalid"
	KeyUnknown KeyStatus = "unknown" // network error or unexpected answer
)

// Errors returned by the key use cases.
var (
	ErrUnknownSlot = errors.New("slot harus wan atau seedance")
	ErrKeyFormat   = errors.New("format key salah, harus <id>:<secret> dari Higgsfield")
	ErrKeyRejected = errors.New("key ditolak Higgsfield (401), tidak disimpan")
)

// keyPattern is the Higgsfield key shape: "<uuid>:<secret>".
var keyPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9]{16,}$`)

// APIKey is a Higgsfield credential. Its String method never prints the secret.
type APIKey string

// ParseAPIKey trims raw and checks its shape.
func ParseAPIKey(raw string) (APIKey, error) {
	k := strings.TrimSpace(raw)
	if !keyPattern.MatchString(k) {
		return "", ErrKeyFormat
	}

	return APIKey(k), nil
}

// Masked returns "abcd1234…wxyz", or "" for an empty key.
func (k APIKey) Masked() string {
	if k == "" {
		return ""
	}

	s := string(k)

	id, _, _ := strings.Cut(s, ":")
	if len(id) > 8 {
		id = id[:8]
	}

	tail := s
	if len(s) > 4 {
		tail = s[len(s)-4:]
	}

	return id + "…" + tail
}

// String keeps the secret out of logs and fmt output.
func (k APIKey) String() string { return k.Masked() }

// KeyInfo is what the settings page shows for one slot.
type KeyInfo struct {
	Slot    KeySlot    `json:"slot"`
	File    string     `json:"file"`
	Engines string     `json:"engines"`
	Set     bool       `json:"set"`
	Masked  *string    `json:"masked"`
	Updated *time.Time `json:"updated"`
	Status  KeyStatus  `json:"status,omitempty"`
}
