package v1

//go:generate sh -c "go run github.com/atombender/go-jsonschema@v0.23.0 -p v1 --struct-name-from-title --capitalization ID --capitalization URL --capitalization NDJSON --tags json --only-models -o types_gen.go ../../../cloud/schemas/worker-protocol-v1/*.json"
