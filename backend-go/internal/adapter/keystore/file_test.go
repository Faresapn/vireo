package keystore_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/keystore"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func TestReplaceBacksUpAndRestrictsPermissions(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	store := keystore.NewFile(dir, "~")
	path := filepath.Join(dir, ".higgsfield_key")

	if k, err := store.Read(entity.SlotWan); err != nil || k != "" {
		t.Fatalf("Read() on missing file = %q, %v; want empty, nil", k, err)
	}

	if err := os.WriteFile(path, []byte("old-key\n"), 0o644); err != nil { //nolint:gosec // G306: world-readable on purpose, Replace must tighten it
		t.Fatal(err)
	}

	if err := store.Replace(entity.SlotWan, "new-key"); err != nil {
		t.Fatal(err)
	}

	if k, _ := store.Read(entity.SlotWan); k != "new-key" {
		t.Fatalf("Read() = %q, want new-key", k)
	}

	if b, _ := os.ReadFile(path + ".bak"); string(b) != "old-key\n" { //nolint:gosec // test temp dir
		t.Fatalf("backup = %q, want old-key", b)
	}

	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("key file mode = %o, want 600", perm)
	}

	if got := store.Path(entity.SlotSeedance); got != "~/.higgsfield_key2" {
		t.Fatalf("Path() = %q", got)
	}

	matches, _ := filepath.Glob(filepath.Join(dir, ".higgsfield_key.tmp-*"))
	if len(matches) != 0 {
		t.Fatalf("temp files left behind: %v", matches)
	}
}
