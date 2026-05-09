# Contrabass — Build Tooling
# Build order: dashboard SPA must build before Go binary (embed.FS requires dist/)

.PHONY: build-dashboard build-landing build build-local-only cloud-build cloud-deploy cloud-deploy-dry cloud-migrate cloud-secret-set cloud-test dev-dashboard dev-dashboard-stack dev-landing dev test test-race test-cover test-dashboard test-landing test-quick test-all ci clean lint release-dry

CLOUD_MIGRATE_FLAGS ?= --remote
CLOUD_SECRET_STORE_ID ?= a6568877039e4cd6a86448cb73b20066
CLOUD_SECRET_SCOPES ?= workers

# Set LOCAL_ONLY=1 to include the single-host runtime (server, team, hub, web, ipc).
# Example: make build LOCAL_ONLY=1  OR  make build-local-only
LOCAL_ONLY ?=
_BUILD_TAG_FLAG := $(if $(LOCAL_ONLY),-tags localonly,)

# Build the React dashboard SPA to packages/dashboard/dist/
build-dashboard:
	cd packages/dashboard && bun run build && touch dist/.gitkeep

# Build the Astro landing site to packages/landing/dist/
build-landing:
	cd packages/landing && bun run build

# Build the Go binary with embedded dashboard (excludes localonly packages by default).
# Use LOCAL_ONLY=1 to include the single-host runtime: make build LOCAL_ONLY=1
build: build-dashboard
	go build $(_BUILD_TAG_FLAG) -ldflags "-X main.version=dev -X main.commit=$$(git rev-parse --short HEAD 2>/dev/null || echo none) -X main.date=$$(date -u +%Y-%m-%dT%H:%M:%SZ)" -o contrabass ./cmd/contrabass

# Build the Go binary with all single-host packages included (server + worker subcommands).
build-local-only: build-dashboard
	go build -tags localonly -ldflags "-X main.version=dev -X main.commit=$$(git rev-parse --short HEAD 2>/dev/null || echo none) -X main.date=$$(date -u +%Y-%m-%dT%H:%M:%SZ)" -o contrabass ./cmd/contrabass

# Build the Cloudflare Worker bundle without publishing it
cloud-build:
	cd cloud && bun run build

# Deploy the Cloudflare Worker
cloud-deploy:
	cd cloud && bun run deploy

# Validate the Cloudflare Worker deploy without publishing it
cloud-deploy-dry:
	cd cloud && bun run deploy:dry

# Apply pending D1 migrations. Override with CLOUD_MIGRATE_FLAGS="--local" for local Wrangler state.
cloud-migrate:
	cd cloud && bun run migrate -- $(CLOUD_MIGRATE_FLAGS)

# Set a tracker token in Cloudflare Secrets Store. Example:
#   make cloud-secret-set TEAM_ID=my-team PROVIDER=linear
cloud-secret-set:
	@cd cloud && \
		TEAM_ID="$(TEAM_ID)" \
		PROVIDER="$(PROVIDER)" \
		CLOUD_SECRET_STORE_ID="$(CLOUD_SECRET_STORE_ID)" \
		CLOUD_SECRET_SCOPES="$(CLOUD_SECRET_SCOPES)" \
		CLOUD_SECRET_VALUE="$(CLOUD_SECRET_VALUE)" \
		../scripts/cloud-secret-set.sh

# Run cloud TypeScript checks and tests
cloud-test:
	cd cloud && bun run typecheck && bun run test

# Start Vite dev server for dashboard development (with hot reload)
dev-dashboard:
	cd packages/dashboard && bun run dev

# Start the dashboard frontend and a local internal-board backend together
dev-dashboard-stack:
	./scripts/dev-dashboard.sh

# Start Astro dev server for landing page development
dev-landing:
	cd packages/landing && bun run dev

# Run Go binary in dev mode
dev:
	go run ./cmd/contrabass --port 8080

# Run all Go tests
test:
	go test ./... -count=1

# Run Go tests with race detector
test-race:
	go test -race ./... -count=1

# Run Go tests with coverage for critical packages (localonly tag required for team/orchestrator)
test-cover:
	go test -tags localonly -coverprofile=coverage.out -covermode=atomic ./internal/team/... ./internal/orchestrator/... ./internal/agent/...
	go tool cover -func=coverage.out | tail -1

# Run React dashboard tests
test-dashboard:
	cd packages/dashboard && bun test

# Run Astro landing checks
test-landing:
	cd packages/landing && bun run check

# Run the recommended local validation path
test-quick: test test-dashboard test-landing

# Run all tests/checks
test-all: test-quick

# Run the preferred CI/local full validation flow
# Dashboard must be built first: embed_dashboard.go requires packages/dashboard/dist/
ci:
	$(MAKE) build-dashboard
	$(MAKE) lint
	$(MAKE) test-quick
	$(MAKE) build
	$(MAKE) build-landing

# Remove build artifacts
clean:
	rm -rf packages/dashboard/dist packages/landing/dist contrabass
	mkdir -p packages/dashboard/dist
	touch packages/dashboard/dist/.gitkeep

# Run Go linter
lint:
	go vet ./...

# Dry-run GoReleaser locally (skips publish)
release-dry: build-dashboard
	goreleaser release --snapshot --clean
