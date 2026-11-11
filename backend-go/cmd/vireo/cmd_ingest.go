package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/ingest"
)

func ingestCmd(a *app) *cobra.Command {
	var order string

	c := &cobra.Command{
		Use:   "ingest <persona_id> [limit] [offset] [cluster] [order]",
		Short: "Pull viral references from ViralEngine into the inbox (was ingest_viral.mjs)",
		Args:  cobra.RangeArgs(1, 5),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts := ingest.Options{Limit: 10}

			if len(args) > 1 && args[1] != "" {
				n, err := strconv.Atoi(args[1])
				if err != nil {
					return usageErr("limit must be a number: %q", args[1])
				}

				opts.Limit = n
			}

			if len(args) > 2 && args[2] != "" {
				if n, err := strconv.Atoi(args[2]); err == nil {
					opts.Offset = &n
				}
			}

			if len(args) > 3 {
				opts.Cluster = args[3]
			}

			if len(args) > 4 && order == "" {
				order = args[4]
			}

			if order == string(entity.OrderDate) {
				opts.Order = entity.OrderDate
			}

			svc, err := a.ingestService(cmd.Context())
			if err != nil {
				return err
			}

			res, err := svc.Ingest(cmd.Context(), args[0], opts)
			if err != nil {
				return err
			}

			return printJSON(res)
		},
	}
	c.Flags().StringVar(&order, "order", "", `"date" (newest) or "velocity" (default)`)

	return c
}

func refreshInboxCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "refresh-inbox [ttl_hours]",
		Short: "Drop stale inbox refs and ingest fresh ones for every cluster persona (was refresh_inbox.mjs)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ttl := 12

			if len(args) == 1 {
				n, err := strconv.Atoi(args[0])
				if err != nil {
					return usageErr("ttl_hours must be a number: %q", args[0])
				}

				ttl = n
			}

			svc, err := a.ingestService(cmd.Context())
			if err != nil {
				return err
			}

			lines, personas, err := svc.Refresh(cmd.Context(), ttl, 8)
			if err != nil {
				return err
			}

			deleted, added := 0, 0

			var out []string

			for _, l := range lines {
				switch {
				case l.Err != nil:
					out = append(out, fmt.Sprintf("%s: ingest error %s", l.Name, truncate(l.Err.Error(), 60)))
				case l.Deleted > 0 || l.Added > 0:
					out = append(out, fmt.Sprintf("%s: -%d stale, +%d fresh", l.Name, l.Deleted, l.Added))
				}

				deleted += l.Deleted
				if l.Err == nil {
					added += l.Added
				}
			}

			if deleted == 0 && added == 0 {
				return nil // quiet on no-op so a cron with delivery stays silent
			}

			fmt.Printf("INBOX refresh (TTL %dh): %d persona, -%d basi, +%d fresh\n", ttl, personas, deleted, added)

			for _, l := range out {
				fmt.Println("  " + l)
			}

			return nil
		},
	}
}

func mcpCmd() *cobra.Command {
	c := &cobra.Command{Use: "mcp", Short: "Talk to the ViralEngine MCP server (was mcp_client.mjs)"}
	c.AddCommand(&cobra.Command{
		Use:  "list",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := viralEngine("higgsfield-studio")
			if err != nil {
				return err
			}

			res, err := cl.Tools(cmd.Context())
			if err != nil {
				return err
			}

			var r struct {
				Tools []json.RawMessage `json:"tools"`
			}

			_ = json.Unmarshal(res, &r)
			b, _ := json.MarshalIndent(r.Tools, "", "  ")
			fmt.Println(string(b))
			fmt.Fprintf(os.Stderr, "\n%d tools.\n", len(r.Tools))

			return nil
		},
	}, &cobra.Command{
		Use:   "call <tool> [json_args]",
		Short: "Call one tool explicitly (never called automatically)",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			toolArgs := map[string]any{}
			if len(args) == 2 {
				if err := json.Unmarshal([]byte(args[1]), &toolArgs); err != nil {
					return usageErr("invalid JSON args: %v", err)
				}
			}

			cl, err := viralEngine("higgsfield-studio")
			if err != nil {
				return err
			}

			res, err := cl.CallRaw(cmd.Context(), args[0], toolArgs)
			if err != nil {
				return err
			}

			var pretty any

			_ = json.Unmarshal(res, &pretty)
			b, _ := json.MarshalIndent(pretty, "", "  ")
			fmt.Println(string(b))

			return nil
		},
	})

	return c
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}

	return string(r[:n])
}
