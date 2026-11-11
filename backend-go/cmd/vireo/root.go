package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Faresapn/vireo/backend-go/internal/infrastructure"
)

// Exit codes. Scripts and orchestrators read these.
const (
	exitOK    = 0
	exitError = 1
	exitUsage = 2
)

// codeError lets a command pick a specific code (idea uses 3 when every try failed).
type codeError struct {
	code int
	err  error
}

func (e *codeError) Error() string { return e.err.Error() }
func (e *codeError) Unwrap() error { return e.err }

func usageErr(format string, args ...any) error {
	return &codeError{code: exitUsage, err: fmt.Errorf(format, args...)}
}

// app holds what every command shares; the database opens lazily.
type app struct {
	root string
	db   *sql.DB
}

func (a *app) personasDir() string { return filepath.Join(a.root, "personas") }
func (a *app) logsDir() string     { return filepath.Join(a.root, "logs") }

func (a *app) open(ctx context.Context) (*sql.DB, error) {
	if a.db != nil {
		return a.db, nil
	}

	db, err := infrastructure.OpenSQLiteRW(ctx, filepath.Join(a.root, "db", "studio.db"))
	if err != nil {
		return nil, err
	}

	a.db = db

	return db, nil
}

// logf writes one progress line to stderr; stdout carries only the JSON result.
func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

func printJSON(v any) error {
	return json.NewEncoder(os.Stdout).Encode(v)
}

// loadDotEnv reads KEY=VALUE lines from path into the environment without
// overriding variables that are already set (as the Node scripts did).
func loadDotEnv(path string) {
	f, err := os.Open(path) //nolint:gosec // G304: the studio's own .env.local
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok || k == "" || strings.HasPrefix(k, "#") || strings.ToUpper(k) != k {
			continue
		}

		if _, set := os.LookupEnv(k); !set {
			_ = os.Setenv(k, strings.TrimSpace(v))
		}
	}
}

func newRoot(a *app) *cobra.Command {
	root := &cobra.Command{
		Use:           "vireo",
		Short:         "Vireo studio worker: ingest, screen, prompt, render, archive, autopilot",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(*cobra.Command, []string) error {
			abs, err := filepath.Abs(a.root)
			if err != nil {
				return fmt.Errorf("resolving root: %w", err)
			}

			a.root = abs
			loadDotEnv(filepath.Join(a.root, ".env.local"))

			return nil
		},
	}
	root.PersistentFlags().StringVar(&a.root, "root", "..", "studio root (holds db/, personas/, logs/)")
	root.AddCommand(
		ingestCmd(a), refreshInboxCmd(a), mcpCmd(),
		screenCmd(a), buildPromptCmd(a), ideaCmd(a),
		generateCmd(a), generateI2VCmd(a), recoverCmd(a),
		archiveCmd(a), autoCmd(a), dailyAutoCmd(a),
	)

	return root
}

func execute() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a := &app{}
	root := newRoot(a)
	err := root.ExecuteContext(ctx)

	if a.db != nil {
		_ = a.db.Close()
	}

	if err == nil {
		return exitOK
	}

	fmt.Fprintln(os.Stderr, "Error:", err)

	if ce, ok := errors.AsType[*codeError](err); ok {
		return ce.code
	}

	if strings.Contains(err.Error(), "unknown command") || strings.Contains(err.Error(), "accepts") ||
		strings.Contains(err.Error(), "unknown flag") || strings.Contains(err.Error(), "requires at least") {
		return exitUsage
	}

	return exitError
}
