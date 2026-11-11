package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Faresapn/vireo/backend-go/internal/idea"
)

func videoArg(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, usageErr("video_id must be a number: %q", s)
	}

	return n, nil
}

// personaVideoCmd builds a "<persona_id> <video_id>" command that prints run's result as JSON.
func personaVideoCmd(use, short string, run func(cmd *cobra.Command, personaID string, videoID int64) (any, error)) *cobra.Command {
	return &cobra.Command{
		Use:   use + " <persona_id> <video_id>",
		Short: short,
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			vid, err := videoArg(args[1])
			if err != nil {
				return err
			}

			res, err := run(cmd, args[0], vid)
			if err != nil {
				return err
			}

			return printJSON(res)
		},
	}
}

func screenCmd(a *app) *cobra.Command {
	return personaVideoCmd("screen-ref", "Score a reference for motion transfer with the vision LLM (was screen_ref.mjs)",
		func(cmd *cobra.Command, personaID string, videoID int64) (any, error) {
			svc, err := a.screenService(cmd.Context())
			if err != nil {
				return nil, err
			}

			return svc.Screen(cmd.Context(), personaID, videoID)
		})
}

func buildPromptCmd(a *app) *cobra.Command {
	var story bool

	c := &cobra.Command{
		Use:   "build-prompt <persona_id> <video_id> [--story] [instruction...]",
		Short: "Write the render prompt from the master prompt and 3 reference frames (was build_prompt.mjs)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			vid, err := videoArg(args[1])
			if err != nil {
				return err
			}

			svc, err := a.promptService(cmd.Context())
			if err != nil {
				return err
			}

			out, err := svc.Build(cmd.Context(), args[0], vid, story, strings.TrimSpace(strings.Join(args[2:], " ")))
			if err != nil {
				return err
			}

			fmt.Println(out)

			return nil
		},
	}
	c.Flags().BoolVar(&story, "story", false, "story mode: keep the motion, vary the content")

	return c
}

func ideaCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "idea <persona_id>",
		Short: "Invent a new, non-duplicate idea draft for an idea-only persona (was generate_idea.mjs)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			svc, err := a.ideaService(cmd.Context())
			if err != nil {
				return err
			}

			res, err := svc.Generate(cmd.Context(), args[0])
			if errors.Is(err, idea.ErrExhausted) {
				return &codeError{code: 3, err: err}
			}

			if err != nil {
				return err
			}

			return printJSON(res)
		},
	}
}
