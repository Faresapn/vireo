package infrastructure

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"time"

	_ "modernc.org/sqlite" // registers the pure-Go "sqlite" driver (no cgo)
)

// OpenSQLite opens path read-only. The Node scripts write the same WAL-mode
// file; readers never block them, and busy_timeout rides out checkpoints.
func OpenSQLite(ctx context.Context, path string) (*sql.DB, error) {
	q := url.Values{}
	q.Set("mode", "ro")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "query_only(1)")

	return open(ctx, path, q)
}

// OpenSQLiteRW opens path for reading and writing, for one-off commands that
// record results (e.g. drive-archive). The Node side owns the schema; this
// handle only updates rows.
func OpenSQLiteRW(ctx context.Context, path string) (*sql.DB, error) {
	q := url.Values{}
	q.Set("mode", "rw")
	q.Add("_pragma", "busy_timeout(10000)")

	return open(ctx, path, q)
}

func open(ctx context.Context, path string, q url.Values) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, fmt.Errorf("opening sqlite: %w", err)
	}

	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("pinging sqlite: %w", err)
	}

	return db, nil
}
