package board

// This file marks the exported boundary of the board package. The internal
// .contrabass board operations live in board.go; the CLI wiring layer in
// cmd/contrabass consumes only the exported LoadTracker + per-subcommand
// helpers. No additional re-exports are required because every consumed
// symbol is already exported with a stable signature.
