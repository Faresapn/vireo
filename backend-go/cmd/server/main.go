// Command server is the Go backend of the Vireo studio dashboard. It serves the
// read API for personas and videos and the Higgsfield key settings, next to
// the Node render scripts that share db/studio.db.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/gateway"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/handler"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/keystore"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/repository"
	"github.com/Faresapn/vireo/backend-go/internal/apikey"
	"github.com/Faresapn/vireo/backend-go/internal/infrastructure"
	"github.com/Faresapn/vireo/backend-go/internal/persona"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	if err := run(); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := infrastructure.LoadConfig()
	if err != nil {
		return err
	}

	db, err := infrastructure.OpenSQLite(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer func() {
		if err := db.Close(); err != nil {
			slog.Warn("closing database", "err", err)
		}
	}()

	// Wiring: adapters -> use cases -> handlers (manual constructor injection).
	personaSvc := persona.NewService(repository.NewSQLite(db))
	keySvc := apikey.NewService(keystore.NewFile(cfg.KeyDir, "~"), gateway.NewHiggsfield(nil))
	router := infrastructure.NewRouter(handler.NewPersona(personaSvc), handler.NewSettings(keySvc))

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)

	go func() {
		slog.Info("listening", "addr", cfg.Addr, "db", cfg.DBPath)

		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}

		return nil
	case <-ctx.Done():
	}

	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return srv.Shutdown(shutdownCtx)
}
