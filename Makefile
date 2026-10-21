# SPDX-License-Identifier: Apache-2.0
#
# Cenacle task runner. The project name, image prefix and compose project are
# defined once here; rename by changing PROJECT.

PROJECT        := cenacle
IMAGE_PREFIX   := $(PROJECT)-
COMPOSE_DEV    := docker compose -p $(PROJECT) -f deploy/compose/dev.yml --env-file .env
SERVER_DIR     := server
BIN_DIR        := $(CURDIR)/.bin

# Pinned tool versions (verified against upstream releases).
SQLC_VERSION          := 1.31.1
GOLANGCI_LINT_VERSION := 2.15.0
GO_LICENSES_VERSION   := v2.0.1
GOVULNCHECK_VERSION   := v1.9.0

# License policy for Go modules (see docs/adr/0001-monorepo-and-tooling.md).
GO_ALLOWED_LICENSES := MIT,ISC,BSD-2-Clause,BSD-3-Clause,Apache-2.0,MPL-2.0,0BSD,Unlicense

UNAME_S := $(shell uname -s | tr '[:upper:]' '[:lower:]')
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
  ARCH := amd64
else ifeq ($(UNAME_M),aarch64)
  ARCH := arm64
else
  ARCH := $(UNAME_M)
endif

# Load local configuration (.env is git-ignored; see .env.example).
-include .env
export

SQLC          := $(BIN_DIR)/sqlc
GOLANGCI_LINT := $(BIN_DIR)/golangci-lint
GO_LICENSES   := $(BIN_DIR)/go-licenses
GOVULNCHECK   := $(BIN_DIR)/govulncheck

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Tooling -----------------------------------------------------------------

.PHONY: tools
tools: $(SQLC) $(GOLANGCI_LINT) $(GO_LICENSES) $(GOVULNCHECK) ## Install pinned dev tools into ./.bin

$(SQLC):
	@mkdir -p $(BIN_DIR)
	curl -fsSL https://github.com/sqlc-dev/sqlc/releases/download/v$(SQLC_VERSION)/sqlc_$(SQLC_VERSION)_$(UNAME_S)_$(ARCH).tar.gz | tar -xz -C $(BIN_DIR) sqlc

$(GOLANGCI_LINT):
	@mkdir -p $(BIN_DIR)
	curl -fsSL https://github.com/golangci/golangci-lint/releases/download/v$(GOLANGCI_LINT_VERSION)/golangci-lint-$(GOLANGCI_LINT_VERSION)-$(UNAME_S)-$(ARCH).tar.gz \
	  | tar -xz -C $(BIN_DIR) --strip-components=1 golangci-lint-$(GOLANGCI_LINT_VERSION)-$(UNAME_S)-$(ARCH)/golangci-lint

$(GO_LICENSES):
	GOBIN=$(BIN_DIR) go install github.com/google/go-licenses/v2@$(GO_LICENSES_VERSION)

$(GOVULNCHECK):
	GOBIN=$(BIN_DIR) go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)

node_modules: package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch node_modules

# --- Local infrastructure ------------------------------------------------------

.PHONY: up
up: ## Start dev infrastructure (postgres, valkey, ldap, mailpit) and wait until healthy
	$(COMPOSE_DEV) up -d --wait

.PHONY: down
down: ## Stop dev infrastructure (keeps volumes)
	$(COMPOSE_DEV) down

.PHONY: ps
ps: ## Show dev infrastructure status
	$(COMPOSE_DEV) ps

# --- Development servers -------------------------------------------------------

.PHONY: dev-server
dev-server: ## Run the Go chat backend
	cd $(SERVER_DIR) && go run ./cmd/server serve

.PHONY: dev-idp
dev-idp: node_modules ## Run the identity server (watch mode)
	pnpm --filter @cenacle/idp dev

.PHONY: dev-web
dev-web: node_modules ## Run the web app (Vite dev server)
	pnpm --filter @cenacle/web dev

# --- Database ------------------------------------------------------------------

.PHONY: migrate-up
migrate-up: ## Apply chat database migrations
	cd $(SERVER_DIR) && go run ./cmd/server migrate up

.PHONY: migrate-down
migrate-down: ## Roll back the latest chat database migration
	cd $(SERVER_DIR) && go run ./cmd/server migrate down

.PHONY: gen
gen: $(SQLC) node_modules ## Generate code (sqlc, OpenAPI types)
	cd $(SERVER_DIR) && $(SQLC) generate
	pnpm --filter @cenacle/core gen:api

# --- Quality gates -------------------------------------------------------------

.PHONY: lint
lint: lint-go lint-js ## Run all linters

.PHONY: lint-go
lint-go: $(GOLANGCI_LINT)
	cd $(SERVER_DIR) && $(GOLANGCI_LINT) run ./...

.PHONY: lint-js
lint-js: node_modules
	pnpm lint
	pnpm typecheck

.PHONY: test
test: test-go test-js ## Run all unit tests

.PHONY: test-go
test-go:
	cd $(SERVER_DIR) && go test -race ./...

.PHONY: test-js
test-js: node_modules
	pnpm test

.PHONY: test-e2e
test-e2e: node_modules ## Run Playwright tests (target size, a11y, no external requests)
	pnpm --filter @cenacle/web test:e2e

.PHONY: licenses
licenses: licenses-go licenses-js ## Check dependency licenses against the policy

.PHONY: licenses-go
licenses-go: $(GO_LICENSES)
	cd $(SERVER_DIR) && $(GO_LICENSES) check ./... --allowed_licenses=$(GO_ALLOWED_LICENSES) --ignore github.com/barisshn35/cenacle

.PHONY: licenses-js
licenses-js: node_modules
	pnpm run check:licenses

.PHONY: vuln
vuln: $(GOVULNCHECK) ## Scan Go code for known vulnerabilities
	cd $(SERVER_DIR) && $(GOVULNCHECK) ./...

# --- Build ---------------------------------------------------------------------

.PHONY: build
build: build-go build-js ## Build all components

.PHONY: build-go
build-go:
	cd $(SERVER_DIR) && CGO_ENABLED=0 go build -trimpath -o bin/$(PROJECT)-server ./cmd/server

.PHONY: build-js
build-js: node_modules
	pnpm build

.PHONY: images
images: ## Build container images for the local architecture
	docker build -f server/Dockerfile -t $(IMAGE_PREFIX)server:dev .
	docker build -f idp/Dockerfile -t $(IMAGE_PREFIX)idp:dev .
	docker build -f web/Dockerfile -t $(IMAGE_PREFIX)web:dev .
	docker build -f deploy/compose/caddy/Dockerfile -t $(IMAGE_PREFIX)proxy:dev .
