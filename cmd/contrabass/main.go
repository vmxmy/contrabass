package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/log"
	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/update"
)

// Build-time variables injected via ldflags.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	if err := newRootCmd().Execute(); err != nil {
		os.Exit(1)
	}
}

// newRootCmd builds the Cobra root command with all CLI flags.
func newRootCmd() *cobra.Command {
	var (
		cfgPath  string
		noTUI    bool
		logFile  string
		logLevel string
		dryRun   bool
		port     int
		host     string
	)

	var updateResult update.Result

	cmd := &cobra.Command{
		Use:     "contrabass",
		Short:   "Orchestrate coding agents with a Charm TUI dashboard",
		Version: fmt.Sprintf("%s (commit: %s, built: %s)", version, commit, date),
		Long: `Contrabass is a Go reimplementation of OpenAI's Symphony.
It orchestrates coding agents against an issue tracker and visualises
progress in a terminal UI built with the Charm stack.`,
		SilenceUsage: true,
		PersistentPreRun: func(cmd *cobra.Command, args []string) {
			updateResult = update.Check(context.Background(), version)
		},
		PersistentPostRun: func(cmd *cobra.Command, args []string) {
			if msg := update.FormatNotification(updateResult); msg != "" {
				fmt.Fprint(os.Stderr, msg)
			}
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return run(cfgPath, noTUI, logFile, logLevel, dryRun, port, host)
		},
	}

	cmd.Flags().StringVar(&cfgPath, "config", "", "path to WORKFLOW.md file (required)")
	cmd.Flags().BoolVar(&noTUI, "no-tui", false, "headless mode — skip TUI, log events to stdout")
	cmd.Flags().StringVar(&logFile, "log-file", "contrabass.log", "log output path")
	cmd.Flags().StringVar(&logLevel, "log-level", "info", "log level (debug/info/warn/error)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "exit after first poll cycle")
	cmd.Flags().IntVar(&port, "port", 0, "web dashboard port (0 = disabled)")
	cmd.Flags().StringVar(&host, "host", "localhost", "web dashboard bind host (e.g. 0.0.0.0 for all interfaces)")

	_ = cmd.MarkFlagRequired("config")

	cmd.AddCommand(teamCmd, boardCmd, configCmd, workerCmd, tuiCmd, migrateCmd, newInitCmd())
	for _, sub := range localOnlySubcmds() {
		cmd.AddCommand(sub)
	}

	return cmd
}

// parseLogLevel converts a string log level to the charmbracelet/log Level.
func parseLogLevel(s string) log.Level {
	switch strings.ToLower(s) {
	case "debug":
		return log.DebugLevel
	case "warn":
		return log.WarnLevel
	case "error":
		return log.ErrorLevel
	default:
		return log.InfoLevel
	}
}

// newSessionID returns an 8-character hex token uniquely identifying this run,
// so concurrent contrabass instances do not interleave entries into a shared log
// file. Falls back to a nanosecond timestamp if crypto/rand is unavailable.
func newSessionID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err == nil {
		return hex.EncodeToString(b[:])
	}
	return strconv.FormatInt(time.Now().UnixNano(), 16)
}
