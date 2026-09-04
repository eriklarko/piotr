.PHONY: install uninstall validate upgrade-pi help

BIN_DIR := $(HOME)/.local/bin
PI_PACKAGE := @earendil-works/pi-coding-agent
HOST_PI_PREFIX := $(HOME)/.pi-sbx/host-pi
PI_VERSION := $(shell tr -d '[:space:]' < kit/pi-version)

help:
	@echo "install      symlink safe-pi and unsafe-pi into $(BIN_DIR)"
	@echo "uninstall    remove the safe-pi and unsafe-pi symlinks"
	@echo "validate     check kit/spec.yaml and that the pi version pin matches kit/pi-version"
	@echo "upgrade-pi   bump kit/pi-version (VERSION=x.y.z or latest), refresh host prefix"

install:
	@mkdir -p $(BIN_DIR)
	@ln -sf $(CURDIR)/safe-pi $(BIN_DIR)/safe-pi
	@ln -sf $(CURDIR)/unsafe-pi $(BIN_DIR)/unsafe-pi
	@echo "symlinked $(BIN_DIR)/safe-pi -> $(CURDIR)/safe-pi"
	@echo "symlinked $(BIN_DIR)/unsafe-pi -> $(CURDIR)/unsafe-pi"
	@echo "next: run 'safe-pi init', then edit ~/.pi-sbx/config"

uninstall:
	@rm -f $(BIN_DIR)/safe-pi $(BIN_DIR)/unsafe-pi
	@echo "removed $(BIN_DIR)/safe-pi and $(BIN_DIR)/unsafe-pi"

validate:
	@grep -q "$(PI_PACKAGE)@$(PI_VERSION)" kit/spec.yaml \
		|| (echo "validate: kit/spec.yaml pin does not match kit/pi-version ($(PI_VERSION))" >&2; exit 1)
	sbx kit validate ./kit

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
	printf '%s\n' "$$new_version" > kit/pi-version; \
	tmp=$$(mktemp); \
	sed -E "s|$(PI_PACKAGE)@[0-9][^[:space:]]*|$(PI_PACKAGE)@$$new_version|g" kit/spec.yaml > "$$tmp"; \
	mv "$$tmp" kit/spec.yaml; \
	mkdir -p $(HOST_PI_PREFIX); \
	npm install --prefix $(HOST_PI_PREFIX) "$(PI_PACKAGE)@$$new_version"; \
	echo "upgrade-pi: pinned $(PI_PACKAGE)@$$new_version"; \
	echo "upgrade-pi: host install refreshed at $(HOST_PI_PREFIX)"; \
	echo "upgrade-pi: recreate sandboxes (safe-pi rm && safe-pi) to pick up the new binary"
