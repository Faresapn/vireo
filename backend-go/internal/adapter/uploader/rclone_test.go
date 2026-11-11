package uploader_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/uploader"
)

// fakeRclone writes a shell script that records its arguments and exits with code.
func fakeRclone(t *testing.T, code int) (bin, argsFile string) {
	t.Helper()
	dir := t.TempDir()
	argsFile = filepath.Join(dir, "args")
	bin = filepath.Join(dir, "rclone")

	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argsFile + "\necho 'Failed to copy: 403 forbidden' >&2\nexit " +
		map[int]string{0: "0", 1: "1"}[code] + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil { //nolint:gosec // test helper script must be executable
		t.Fatal(err)
	}

	return bin, argsFile
}

func TestCopyArgs(t *testing.T) {
	t.Parallel()

	bin, argsFile := fakeRclone(t, 0)
	if err := uploader.NewRclone(bin, "gdrive:").Copy(context.Background(), "/a b/v.mp4", "11-11-2026_Kepin Anatoly_1.mp4", "FOLDER"); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(argsFile) //nolint:gosec // test temp file
	if err != nil {
		t.Fatal(err)
	}

	want := "copyto\n/a b/v.mp4\ngdrive:11-11-2026_Kepin Anatoly_1.mp4\n--drive-root-folder-id\nFOLDER\n"
	if string(got) != want {
		t.Fatalf("args =\n%s\nwant\n%s", got, want)
	}
}

func TestCopyFailureCarriesRcloneMessage(t *testing.T) {
	t.Parallel()
	bin, _ := fakeRclone(t, 1)

	err := uploader.NewRclone(bin, "gdrive:").Copy(context.Background(), "/v.mp4", "x.mp4", "")
	if err == nil || !strings.Contains(err.Error(), "403 forbidden") {
		t.Fatalf("err = %v, want rclone's message", err)
	}
}
