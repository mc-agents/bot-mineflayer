IMAGE ?= ghcr.io/mc-agents/bot-mineflayer
COMPOSE ?= docker compose -f dev/compose.yml

.PHONY: check
check:
	pnpm install --frozen-lockfile
	pnpm check:version
	pnpm typecheck
	pnpm lint
	pnpm test

# Local check only. GitHub Actions is what publishes to the registry.
.PHONY: image
image:
	docker buildx build --load -t $(IMAGE):local .

.PHONY: dev-up dev-down dev-logs
dev-up:
	$(COMPOSE) up -d

dev-down:
	$(COMPOSE) down

dev-logs:
	$(COMPOSE) logs -f minecraft

# Copies the argument hashes out of mcp-server's catalogue. Run it after the catalogue changes.
.PHONY: catalog
catalog:
	pnpm sync:catalog
	git diff --stat -- src/rpc/catalog-hashes.ts

.PHONY: clean
clean:
	rm -rf dist
