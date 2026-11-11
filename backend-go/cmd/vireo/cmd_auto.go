package main

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/Faresapn/vireo/backend-go/internal/autopilot"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func archiveCmd(a *app) *cobra.Command {
	var (
		dryRun         bool
		remote, rclone string
	)

	c := &cobra.Command{
		Use:   "drive-archive <persona_id> <video_id>",
		Short: "Upload a finished video to Google Drive (was drive_archive.mjs)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			vid, err := videoArg(args[1])
			if err != nil {
				return err
			}

			svc, err := a.archiveService(cmd.Context(), remote, rclone)
			if err != nil {
				return err
			}

			res, err := svc.Archive(cmd.Context(), args[0], vid, dryRun)
			if err != nil {
				return err
			}

			return printJSON(res)
		},
	}
	c.Flags().BoolVar(&dryRun, "dry-run", false, "print the plan; no upload, no database write")
	c.Flags().StringVar(&remote, "remote", "gdrive:", "rclone remote")
	c.Flags().StringVar(&rclone, "rclone", "rclone", "rclone binary")

	return c
}

func autoCmd(a *app) *cobra.Command {
	var (
		o     autopilot.AutoOptions
		order string
	)

	c := &cobra.Command{
		Use:   "auto <persona_id> [count]",
		Short: "PAID: ingest → pick ref → prompt → render, retrying other refs (was auto_generate.mjs)",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			o.Count = optInt(args, 1)
			if order == string(entity.OrderDate) {
				o.Order = entity.OrderDate
			}

			if o.Resolution != "480p" && o.Resolution != "720p" {
				o.Resolution = ""
			}

			svc, err := a.autopilot(cmd.Context())
			if err != nil {
				return err
			}

			res, err := svc.Auto(cmd.Context(), args[0], o)
			if err != nil {
				return err
			}

			return printJSON(res)
		},
	}
	c.Flags().StringVar(&o.Resolution, "res", "", "480p or 720p (default: persona render_res)")
	c.Flags().StringVar(&order, "order", "", `"date" pulls and prefers the newest refs`)
	c.Flags().BoolVar(&o.Fresh, "fresh", false, "ingest new refs first, even if the inbox has some")
	c.Flags().Float64Var(&o.MaxDur, "max-dur", 0, "skip refs longer than N seconds")

	return c
}

func dailyAutoCmd(a *app) *cobra.Command {
	var dryRun bool

	c := &cobra.Command{
		Use:   "daily-auto",
		Short: "PAID: the 11:00 run over every persona with the toggle on (was daily_auto.mjs)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			svc, err := a.autopilot(cmd.Context())
			if err != nil {
				return err
			}

			if err := os.MkdirAll(a.logsDir(), 0o750); err != nil {
				return fmt.Errorf("creating logs dir: %w", err)
			}

			d := autopilot.NewDaily(svc, time.Now, a.logsDir(), func(s string) { fmt.Println(s) })

			return d.Run(cmd.Context(), dryRun)
		},
	}
	c.Flags().BoolVar(&dryRun, "dry-run", false, "list what would run; no LLM call, no render")

	return c
}
