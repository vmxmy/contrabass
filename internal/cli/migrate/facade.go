package migrate

// This file is the exported boundary of the migrate package. The cloud
// load/upload pipeline stays unexported; only the command entry point the CLI
// wiring layer consumes is re-exported here. The package's own tests exercise
// the unexported pipeline directly.
