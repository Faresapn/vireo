// Package keystore implements apikey.Store with one file per key in a
// directory (the home directory in production). The Node render scripts read
// these files fresh on every run, so a saved key applies to the next render.
package keystore

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

var fileNames = map[entity.KeySlot]string{
	entity.SlotWan:      ".higgsfield_key",
	entity.SlotSeedance: ".higgsfield_key2",
}

// File stores keys as <dir>/.higgsfield_key and <dir>/.higgsfield_key2.
type File struct {
	dir     string
	display string // how dir is shown to users, e.g. "~"
}

// NewFile returns a store rooted at dir. display replaces dir in Path output.
func NewFile(dir, display string) *File {
	return &File{dir: dir, display: display}
}

func (f *File) path(slot entity.KeySlot) string { return filepath.Join(f.dir, fileNames[slot]) }

// Path returns the display path, e.g. "~/.higgsfield_key".
func (f *File) Path(slot entity.KeySlot) string { return f.display + "/" + fileNames[slot] }

// Read returns the stored key, or "" when the file does not exist.
func (f *File) Read(slot entity.KeySlot) (entity.APIKey, error) {
	b, err := os.ReadFile(f.path(slot))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}

	if err != nil {
		return "", fmt.Errorf("reading key file: %w", err)
	}

	return entity.APIKey(strings.TrimSpace(string(b))), nil
}

// ModTime returns the file's modification time.
func (f *File) ModTime(slot entity.KeySlot) (time.Time, bool) {
	st, err := os.Stat(f.path(slot))
	if err != nil {
		return time.Time{}, false
	}

	return st.ModTime().UTC(), true
}

// Replace copies the current key to <file>.bak, then atomically swaps in the
// new key (write temp file, rename) so a crash never leaves a half-written key.
func (f *File) Replace(slot entity.KeySlot, key entity.APIKey) error {
	p := f.path(slot)
	// p is built from a fixed file name under the configured dir, never from user input.
	if old, err := os.ReadFile(p); err == nil { //nolint:gosec // G304/G703: see above
		if err := os.WriteFile(p+".bak", old, 0o600); err != nil { //nolint:gosec // G703: same fixed path
			return fmt.Errorf("writing backup: %w", err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("reading old key: %w", err)
	}

	tmp, err := os.CreateTemp(f.dir, ".higgsfield_key.tmp-*")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // no-op after a successful rename

	if _, err := tmp.WriteString(string(key) + "\n"); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing temp file: %w", err)
	}

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}

	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp file: %w", err)
	}

	if err := os.Rename(tmp.Name(), p); err != nil {
		return fmt.Errorf("replacing key file: %w", err)
	}

	return nil
}
