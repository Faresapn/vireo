// Package uploader copies files to cloud storage.
package uploader

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Rclone uploads with the rclone CLI ("rclone copyto").
type Rclone struct {
	bin    string // rclone binary
	remote string // remote name with colon, e.g. "gdrive:"
}

// NewRclone returns an uploader for remote using the rclone binary bin.
func NewRclone(bin, remote string) *Rclone {
	return &Rclone{bin: bin, remote: remote}
}

// Copy runs rclone copyto, which overwrites a file of the same name.
func (r *Rclone) Copy(ctx context.Context, localPath, remotePath, folderID string) error {
	args := []string{"copyto", localPath, r.remote + remotePath}
	if folderID != "" {
		args = append(args, "--drive-root-folder-id", folderID)
	}

	var stderr bytes.Buffer

	cmd := exec.CommandContext(ctx, r.bin, args...) //nolint:gosec // G204: fixed binary, arguments are paths, not a shell

	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("rclone copyto: %w: %s", err, lastLine(stderr.String()))
	}

	return nil
}

// lastLine keeps the error short: rclone's useful message is its last line.
func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}

	return s
}
