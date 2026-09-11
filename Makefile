.PHONY: bootstrap install uninstall validate upgrade-pi test-extensions help

BIN_DIR := $(HOME)/.local/bin
PI_LINK := $(HOME)/.pi
# The four repo roots that together make up ~/.pi. Read straight from the repo,
# never through the ~/.pi symlinks.
EXT_DIR := $(CURDIR)/extensions
NPM_DIR := $(CURDIR)/installed-extensions
CONFIG_DIR := $(CURDIR)/config
SANDBOX_DIR := $(CURDIR)/docker-sandbox
SBX_CONFIG := $(HOME)/.pi-sbx/config
PI_PACKAGE := @earendil-works/pi-coding-agent
HOST_PI_PREFIX := $(HOME)/.pi-sbx/host-pi
# spec.yaml is a static manifest, so it has to carry the pin literally.
# That makes it the single source of truth; everything else reads it back out.
PI_VERSION := $(shell sed -nE 's|.*$(PI_PACKAGE)@([0-9][^[:space:]]*).*|\1|p' $(SANDBOX_DIR)/spec.yaml | head -1)

# Everything install/uninstall links into ~/.pi, as "<path under ~/.pi>:<repo target>".
PI_LINKS := \
	agent/extensions:$(EXT_DIR) \
	agent/npm:$(NPM_DIR) \
	agent/skills:$(CONFIG_DIR)/agent/skills \
	agent/sessions:$(CONFIG_DIR)/agent/sessions \
	agent/settings.json:$(CONFIG_DIR)/agent/settings.json \
	agent/keybindings.json:$(CONFIG_DIR)/agent/keybindings.json \
	agent/auth.json:$(CONFIG_DIR)/agent/auth.json \
	agent/trust.json:$(CONFIG_DIR)/agent/trust.json \
	agent/models-store.json:$(CONFIG_DIR)/agent/models-store.json \
	memory:$(CONFIG_DIR)/memory

help:
	@echo "bootstrap    one-command setup on a new machine (install + links + packages)"
	@echo "install      symlink safe-pi/unsafe-pi into $(BIN_DIR) and assemble ~/.pi from this repo"
	@echo "uninstall    remove the safe-pi, unsafe-pi and ~/.pi symlinks"
	@echo "validate     check the sandbox kit spec and that the pi pin is readable"
	@echo "test-extensions  run the pure-logic tests for the agent extensions"
	@echo "upgrade-pi   bump the pi pin in docker-sandbox/spec.yaml (VERSION=x.y.z or latest)"

# Single entry point for a new machine. Idempotent.
bootstrap: install
	@if [ ! -f $(SBX_CONFIG) ]; then \
		mkdir -p $(dir $(SBX_CONFIG)); chmod 700 $(dir $(SBX_CONFIG)); \
		cp $(CONFIG_DIR)/sbx-config.template $(SBX_CONFIG); \
		chmod 600 $(SBX_CONFIG); \
		echo "seeded $(SBX_CONFIG) from config/sbx-config.template"; \
	else \
		echo "$(SBX_CONFIG) already exists — left alone"; \
	fi
	@echo "installing pi packages into $(NPM_DIR)"
	@npm install --prefix $(NPM_DIR) --silent
	@echo
	@echo "bootstrap done. Remaining manual steps:"
	@echo "  1. sbx login                       (Docker Sandboxes)"
	@echo "  2. gh auth login                   (token is read via 'gh auth token')"
	@echo "  3. unsafe-pi  then /login          (provider credentials -> config/agent/auth.json)"

install:
	@mkdir -p $(BIN_DIR)
	@ln -sf $(CURDIR)/safe-pi $(BIN_DIR)/safe-pi
	@ln -sf $(CURDIR)/unsafe-pi $(BIN_DIR)/unsafe-pi
	@echo "symlinked $(BIN_DIR)/safe-pi -> $(CURDIR)/safe-pi"
	@echo "symlinked $(BIN_DIR)/unsafe-pi -> $(CURDIR)/unsafe-pi"
	@# ~/.pi is a real directory holding one symlink per child, not a single
	@# symlink to this repo: pi writes its own host-local state in there
	@# (agent/git/, caches) and that should not land in the repo. An older
	@# install did use a single symlink, so remove that first if present.
	@if [ -L $(PI_LINK) ]; then \
		rm -f $(PI_LINK); \
		echo "removed the old single $(PI_LINK) symlink (repo data untouched)"; \
	elif [ -e $(PI_LINK) ] && [ ! -d $(PI_LINK) ]; then \
		echo "ERROR: $(PI_LINK) exists and is not a directory." >&2; \
		exit 1; \
	fi
	@mkdir -p $(PI_LINK)/agent
	@set -eu; for entry in $(PI_LINKS); do \
		name=$${entry%%:*}; target=$${entry#*:}; \
		link=$(PI_LINK)/$$name; \
		if [ ! -e "$$target" ]; then \
			echo "skipped $$link (no $$target yet)"; \
			continue; \
		fi; \
		if [ -e "$$link" ] && [ ! -L "$$link" ]; then \
			echo "ERROR: $$link exists and is not a symlink." >&2; \
			echo "Move its contents into $$target, remove $$link, then re-run make install." >&2; \
			exit 1; \
		fi; \
		ln -sfn "$$target" "$$link"; \
		echo "symlinked $$link -> $$target"; \
	done

uninstall:
	@rm -f $(BIN_DIR)/safe-pi $(BIN_DIR)/unsafe-pi
	@echo "removed $(BIN_DIR)/safe-pi and $(BIN_DIR)/unsafe-pi"
	@# Only ever remove symlinks we created. $(PI_LINK) itself stays: pi writes
	@# its own host-local state in there (e.g. agent/git/) that is not ours.
	@if [ -L $(PI_LINK) ]; then \
		rm -f $(PI_LINK); echo "removed the legacy $(PI_LINK) symlink (repo untouched)"; \
	else \
		for entry in $(PI_LINKS); do \
			link=$(PI_LINK)/$${entry%%:*}; \
			if [ -L "$$link" ]; then rm -f "$$link"; echo "removed $$link"; fi; \
		done; \
	fi

validate:
	@# An unreadable pin is silent otherwise: PI_VERSION just comes back empty.
	@[ -n "$(PI_VERSION)" ] \
		|| (echo "validate: no $(PI_PACKAGE) version pin found in $(SANDBOX_DIR)/spec.yaml" >&2; exit 1)
	@echo "pi pinned at $(PI_VERSION)"
	sbx kit validate $(SANDBOX_DIR)

# Pure-logic regression tests for the extensions under $(EXT_DIR). The
# mode-controller test imports the real implementation; the scoped-tools one
# keeps copies of the pure helpers and must be updated alongside them.
test-extensions:
	node --experimental-strip-types $(EXT_DIR)/mode-controller/gate-logic.test.mjs
	node $(EXT_DIR)/scoped-tools/gate-logic.test.mjs

# Bump the pin and refresh the host-only install under ~/.pi-sbx/host-pi.
# Sandboxes pick up the new pin on recreate (safe-pi rm && safe-pi).
# Usage: make upgrade-pi          # latest from npm
#        make upgrade-pi VERSION=0.85.0
upgrade-pi:
	@command -v npm >/dev/null 2>&1 || (echo "upgrade-pi: npm not found" >&2; exit 1)
	@new_version="$(VERSION)"; \
	if [ -z "$$new_version" ]; then new_version=$$(npm view $(PI_PACKAGE) version); fi; \
	echo "$$new_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.+-].*)?$$' \
		|| (echo "upgrade-pi: invalid version '$$new_version'" >&2; exit 1); \
	tmp=$$(mktemp); \
	sed -E "s|$(PI_PACKAGE)@[0-9][^[:space:]]*|$(PI_PACKAGE)@$$new_version|g" $(SANDBOX_DIR)/spec.yaml > "$$tmp"; \
	mv "$$tmp" $(SANDBOX_DIR)/spec.yaml; \
	mkdir -p $(HOST_PI_PREFIX); \
	npm install --prefix $(HOST_PI_PREFIX) "$(PI_PACKAGE)@$$new_version"; \
	echo "upgrade-pi: pinned $(PI_PACKAGE)@$$new_version"; \
	echo "upgrade-pi: host install refreshed at $(HOST_PI_PREFIX)"; \
	echo "upgrade-pi: recreate sandboxes (safe-pi rm && safe-pi) to pick up the new binary"
