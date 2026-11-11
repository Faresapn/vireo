// Package osfs adapts the local file system to the use case ports.
package osfs

import "os"

// FS is the real file system.
type FS struct{}

// Exists reports whether path is an existing regular file.
func (FS) Exists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}
