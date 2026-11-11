package main

import (
	"strconv"

	"github.com/spf13/cobra"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func optInt(args []string, i int) int {
	if len(args) <= i {
		return 0
	}

	n, _ := strconv.Atoi(args[i])

	return n
}

func generateCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "generate <persona_id> <video_id> <engine> [resolution] [duration]",
		Short: "PAID: motion-transfer render of a reference (was generate.mjs)",
		Args:  cobra.RangeArgs(3, 5),
		RunE: func(cmd *cobra.Command, args []string) error {
			vid, err := videoArg(args[1])
			if err != nil {
				return err
			}

			engine := entity.Engine(args[2])
			if !engine.Valid() {
				return usageErr("unknown engine %q", args[2])
			}

			res := "720p"
			if len(args) > 3 {
				res = args[3]
			}

			svc, err := a.renderService(cmd.Context())
			if err != nil {
				return err
			}

			out, err := svc.Generate(cmd.Context(), args[0], vid, engine, res, optInt(args, 4))
			if err != nil {
				return err
			}

			return printJSON(out)
		},
	}
}

func generateI2VCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "generate-i2v <persona_id> <video_id> [resolution] [duration]",
		Short: "PAID: Seedance 2.5 render from the character image + idea prompt (was generate_i2v.mjs)",
		Args:  cobra.RangeArgs(2, 4),
		RunE: func(cmd *cobra.Command, args []string) error {
			vid, err := videoArg(args[1])
			if err != nil {
				return err
			}

			res := "720p"
			if len(args) > 2 {
				res = args[2]
			}

			svc, err := a.renderService(cmd.Context())
			if err != nil {
				return err
			}

			out, err := svc.GenerateI2V(cmd.Context(), args[0], vid, res, optInt(args, 3))
			if err != nil {
				return err
			}

			return printJSON(out)
		},
	}
}

func recoverCmd(a *app) *cobra.Command {
	return personaVideoCmd("recover", "Re-poll a stored request id and save the output; never submits (was recover_render.mjs)",
		func(cmd *cobra.Command, personaID string, videoID int64) (any, error) {
			svc, err := a.renderService(cmd.Context())
			if err != nil {
				return nil, err
			}

			return svc.Recover(cmd.Context(), personaID, videoID)
		})
}
