// Package infrastructure holds the framework and driver glue: config, the
// database connection and the HTTP router.
package infrastructure

import (
	"fmt"
	"os"
	"path/filepath"
)

// Config is read from the environment (12-factor).
type Config struct {
	Addr   string // VIREO_GO_ADDR, default 127.0.0.1:4320 (loopback only: Next.js does auth)
	DBPath string // VIREO_DB, default ../db/studio.db
	KeyDir string // VIREO_KEY_DIR, default $HOME
}

// LoadConfig reads Config from the environment with defaults.
func LoadConfig() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("finding home dir: %w", err)
	}

	c := Config{
		Addr:   env("VIREO_GO_ADDR", "127.0.0.1:4320"),
		DBPath: env("VIREO_DB", filepath.Join("..", "db", "studio.db")),
		KeyDir: env("VIREO_KEY_DIR", home),
	}
	if _, err := os.Stat(c.DBPath); err != nil {
		return Config{}, fmt.Errorf("database %s: %w", c.DBPath, err)
	}

	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}

	return def
}
