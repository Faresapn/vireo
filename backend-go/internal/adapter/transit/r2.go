// Package transit uploads render inputs to a public bucket (Cloudflare R2)
// so Higgsfield can fetch them by URL, and deletes them afterwards.
package transit

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// R2 uses rclone's S3 backend ("r2:" remote).
type R2 struct {
	Rclone string // rclone binary, default "rclone"
	Remote string // rclone remote name without colon, default "r2"
	Bucket string
	Prefix string
	CDN    string // public base URL of the bucket
}

func (r R2) bin() string {
	if r.Rclone != "" {
		return r.Rclone
	}

	return "rclone"
}

func (r R2) target(name string) string {
	remote := r.Remote
	if remote == "" {
		remote = "r2"
	}

	return fmt.Sprintf("%s:%s/%s/%s", remote, r.Bucket, r.Prefix, name)
}

// Upload copies local to the transit folder as name and returns its public URL.
func (r R2) Upload(ctx context.Context, local, name string) (string, error) {
	var stderr bytes.Buffer

	cmd := exec.CommandContext(ctx, r.bin(), "copyto", local, r.target(name), "--s3-no-check-bucket") //nolint:gosec // G204: fixed binary

	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("r2 upload %s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}

	return fmt.Sprintf("%s/%s/%s", strings.TrimRight(r.CDN, "/"), r.Prefix, name), nil
}

// Delete removes name from the transit folder. Errors are ignored: transit
// files are temporary and a leftover one is harmless.
func (r R2) Delete(ctx context.Context, name string) {
	_ = exec.CommandContext(ctx, r.bin(), "delete", r.target(name), "--s3-no-check-bucket").Run() //nolint:gosec // G204: fixed binary
}
