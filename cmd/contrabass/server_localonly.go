//go:build localonly

package main

import (
	"github.com/spf13/cobra"

	"github.com/junhoyeo/contrabass/internal/cli/server"
)

// This file is the thin localonly wiring shim for the single-host server
// runtime. The execution logic lives in internal/cli/server; cmd keeps only
// the build-tag-split entry points main.go calls (run / localOnlySubcmds).
// server_stub.go is the !localonly counterpart. Mirrors the P0 facade split.

// localOnlySubcmds returns the subcommands only available in localonly builds.
func localOnlySubcmds() []*cobra.Command {
	return []*cobra.Command{teamCmd}
}

// run is the main entry point wired into the root command's RunE.
func run(cfgPath string, noTUI bool, logFile, logLevel string, dryRun bool, port int, host string) error {
	return server.Run(server.Config{
		ConfigPath: cfgPath,
		NoTUI:      noTUI,
		LogFile:    logFile,
		LogLevel:   logLevel,
		DryRun:     dryRun,
		Port:       port,
		Host:       host,
		Version:    version,
		Commit:     commit,
		Date:       date,
	})
}
