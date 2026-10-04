.PHONY: bootstrap install uninstall packages image validate upgrade-pi test test-bootstrap test-extensions typecheck skills-deps help

BIN_DIR := $(HOME)/.local/bin
PI_LINK := $(HOME)/.pi
# The repo roots linked into ~/.pi. Read straight from the repo, never through
# the ~/.pi symlinks.
EXT_DIR := $(CURDIR)/extensions
EXTENSION_TESTS := $(sort $(wildcard $(EXT_DIR)/*/*.test.mjs))
NPM_DIR := $(CURDIR)/installed-extensions
SKILLS_DIR := $(CURDIR)/skills
CONFIG_DIR := $(CURDIR)/config
SANDBOX_DIR := $(CURDIR)/docker-sandbox
PI_PACKAGE := @earendil-works/pi-coding-agent
# The host-only pi install unsafe-pi execs. Machine-local, so it lives in
# ~/.pi with the rest of pi's state.
HOST_PI_PREFIX := $(HOME)/.pi/host-pi
# The Dockerfile bakes pi into the sandbox image, so it carries the pin as an
# ARG. That makes it the single source of truth; the Makefile, unsafe-pi and
# the spec.yaml image tag all read it back out.
DOCKERFILE := $(SANDBOX_DIR)/Dockerfile
PI_VERSION := $(shell sed -nE 's|^ARG PI_VERSION=([0-9][^[:space:]]*).*|\1|p' $(DOCKERFILE) | head -1)
# The sandbox image is tagged with the pi version it contains, so a stale
# image can never masquerade as a current one.
IMAGE_REPO := pi-sandbox
IMAGE := $(IMAGE_REPO):$(PI_VERSION)

# Everything install/uninstall links into ~/.pi, as "<path under ~/.pi>:<repo
# target>". Only tracked things appear here. pi's own machine-local state
# (auth.json, trust.json, models-store.json, agent/sessions/) is real and
# lives directly in ~/.pi, so it is never linked and never touched.
PI_LINKS := \
	agent/extensions:$(EXT_DIR) \
	agent/npm:$(NPM_DIR) \
	agent/skills:$(SKILLS_DIR) \
	agent/settings.json:$(CONFIG_DIR)/settings.json \
	agent/keybindings.json:$(CONFIG_DIR)/keybindings.json

help:
	@echo "bootstrap    one-command setup on a new machine (install + links + packages + image)"
	@echo "install      symlink safe-pi/unsafe-pi into $(BIN_DIR) and assemble ~/.pi from this repo"
	@echo "uninstall    remove the safe-pi, unsafe-pi and ~/.pi symlinks"
	@echo "packages     npm install the pi packages in $(NPM_DIR)"
	@echo "image        rebuild $(IMAGE) and load it into the sbx image store"
	@echo "validate     check the kit spec, the pi pin and that the image exists"
	@echo "test         typecheck + test-extensions, plus shellcheck if it's installed"
	@echo "test-extensions  run the pure-logic tests for the agent extensions"
	@echo "typecheck    tsc --noEmit over extensions/ (needs 'npm install --prefix extensions' once)"
	@echo "skills-deps  npm install for every skills/*/scripts/package.json"
	@echo "upgrade-pi   bump the pi pin in docker-sandbox/Dockerfile (VERSION=x.y.z or latest)"

# Single entry point for a new machine. Idempotent. Includes the sandbox image:
# nothing runs without it, and skipping it surfaces much later as an opaque
# "403 Forbidden: pull failed" from sbx.
bootstrap: install
	@$(MAKE) --no-print-directory packages
	@echo
	@$(MAKE) --no-print-directory skills-deps
	@echo
	@# Last, because it is the only step needing Docker up and sbx signed in.
	@# Everything above has already landed if this fails, and re-running is safe.
	@$(MAKE) --no-print-directory image || { \
		echo; \
		echo "bootstrap: could not build $(IMAGE)."; \
		echo "If you are not signed in to Docker Sandboxes yet:"; \
		echo "  sbx login && make bootstrap"; \
		exit 1; \
	}
	@echo
	@echo "bootstrap done. Remaining manual steps:"
	@echo "  1. gh auth login   (token is read via 'gh auth token')"
	@echo "  2. safe-pi         (then /login inside it, and 'safe-pi login' to keep it)"

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
	@# Only ever remove symlinks we created. $(PI_LINK) itself stays: the
	@# credentials and sessions in there are real files, not ours.
	@if [ -L $(PI_LINK) ]; then \
		rm -f $(PI_LINK); echo "removed the legacy $(PI_LINK) symlink (repo untouched)"; \
	else \
		for entry in $(PI_LINKS); do \
			link=$(PI_LINK)/$${entry%%:*}; \
			if [ -L "$$link" ]; then rm -f "$$link"; echo "removed $$link"; fi; \
		done; \
	fi

# The third-party pi packages that ship into a sandbox. Always run against
# $(NPM_DIR), the real repo path: installing through the ~/.pi/agent/npm
# symlink instead makes npm treat this directory as an out-of-tree "file:"
# dependency and rewrite every package-lock.json path as ../../../Code/...
packages:
	@command -v npm >/dev/null 2>&1 || (echo "packages: npm not found — install Node.js first" >&2; exit 1)
	@echo "installing pi packages into $(NPM_DIR)"
	@npm install --prefix $(NPM_DIR) --silent

# Build the sandbox image and hand it to sbx. sbx keeps its own image store,
# separate from the host Docker daemon, and only `sbx template load` writes to
# it — so a plain `docker build` is not enough. The attestation manifests
# buildx adds by default are not loadable, hence --provenance/--sbom=false.
image:
	@command -v docker >/dev/null 2>&1 || (echo "image: docker not found" >&2; exit 1)
	@command -v sbx >/dev/null 2>&1 \
		|| (echo "image: sbx not found — brew install docker/tap/sbx, then sbx login" >&2; exit 1)
	@docker info >/dev/null 2>&1 || (echo "image: Docker is not running" >&2; exit 1)
	docker build --provenance=false --sbom=false -t $(IMAGE) $(SANDBOX_DIR)
	@# Chained with && and cleaned up via trap: semicolons here would let a
	@# failed load be masked by the exit status of the rm that followed it.
	@tar=$$(mktemp) || exit; \
	trap 'rm -f "$$tar"' EXIT; \
	docker save $(IMAGE) -o "$$tar" && sbx template load "$$tar"
	@echo "image: loaded $(IMAGE); recreate sandboxes (safe-pi rm && safe-pi) to pick it up"

validate:
	@# An unreadable pin is silent otherwise: PI_VERSION just comes back empty.
	@[ -n "$(PI_VERSION)" ] \
		|| (echo "validate: no ARG PI_VERSION pin found in $(DOCKERFILE)" >&2; exit 1)
	@echo "pi pinned at $(PI_VERSION)"
	@# The spec names the image by tag, so the two can drift. A mismatch means
	@# sandboxes would boot an image built for a different pi version.
	@grep -q '^  image: "$(IMAGE)"$$' $(SANDBOX_DIR)/spec.yaml \
		|| (echo "validate: spec.yaml image does not match $(IMAGE) — run 'make image'" >&2; exit 1)
	@sbx template ls | grep -q '$(IMAGE_REPO) *$(PI_VERSION)' \
		|| (echo "validate: $(IMAGE) is not in the sbx image store — run 'make image'" >&2; exit 1)
	@echo "sandbox image $(IMAGE) present"
	sbx kit validate $(SANDBOX_DIR)

# Everything that can be checked without Docker or sbx: typecheck, the pure-
# logic tests, and (if installed) shellcheck over the shell entry points.
# `make image`/`make validate` are the remaining, Docker-dependent checks.
test: typecheck test-extensions test-bootstrap
	@if command -v shellcheck >/dev/null 2>&1; then \
		echo "shellcheck safe-pi unsafe-pi $(SANDBOX_DIR)/gh-guard"; \
		shellcheck safe-pi unsafe-pi $(SANDBOX_DIR)/gh-guard; \
	else \
		echo "shellcheck not installed, skipping (brew install shellcheck)"; \
	fi

# Isolated Makefile regression tests; no real home directory or Docker changes.
test-bootstrap:
	node --test tests/bootstrap.test.mjs

# Pure-logic regression tests discovered in each extension directory.
test-extensions:
	@set -e; for test in $(EXTENSION_TESTS); do \
		node --experimental-strip-types "$$test"; \
	done

# extensions/'s own package.json exists only to typecheck against the same pi
# API surface a sandbox actually runs (see extensions/package.json) -- it
# ships nothing. First run: npm install --prefix $(EXT_DIR).
typecheck:
	@[ -d $(EXT_DIR)/node_modules ] \
		|| (echo "typecheck: run 'npm install --prefix $(EXT_DIR)' first" >&2; exit 1)
	@npm exec --prefix $(EXT_DIR) -- tsc -p $(EXT_DIR)/tsconfig.json

# Skills bundle their own optional scripts/ (see skills/README.md). Unlike
# installed-extensions/, these are installed on the host only: skills/ is
# mounted read-only into every sandbox (or copied read-only, see safe-pi), so
# whatever node_modules exists here at mount/copy time is what the sandbox
# gets. Run this again (or 'safe-pi sync' to refresh an existing sandbox's
# copy) after adding a skill dependency.
skills-deps:
	@command -v npm >/dev/null 2>&1 || (echo "skills-deps: npm not found" >&2; exit 1)
	@for pkg in $(SKILLS_DIR)/*/scripts/package.json; do \
		[ -f "$$pkg" ] || continue; \
		dir=$$(dirname "$$pkg"); \
		echo "installing skill script dependencies in $$dir"; \
		npm install --prefix "$$dir" --silent; \
	done

# Bump the pin, refresh the host-only install under $(HOST_PI_PREFIX), and
# rebuild the sandbox image. Sandboxes pick up the new image on recreate
# (safe-pi rm && safe-pi).
# Usage: make upgrade-pi          # latest from npm
#        make upgrade-pi VERSION=0.85.0
upgrade-pi:
	@command -v npm >/dev/null 2>&1 || (echo "upgrade-pi: npm not found" >&2; exit 1)
	@new_version="$(VERSION)"; \
	if [ -z "$$new_version" ]; then new_version=$$(npm view $(PI_PACKAGE) version); fi; \
	echo "$$new_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.+-].*)?$$' \
		|| (echo "upgrade-pi: invalid version '$$new_version'" >&2; exit 1); \
	tmp=$$(mktemp); \
	sed -E "s|^ARG PI_VERSION=.*|ARG PI_VERSION=$$new_version|" $(DOCKERFILE) > "$$tmp"; \
	mv "$$tmp" $(DOCKERFILE); \
	tmp=$$(mktemp); \
	sed -E "s|^  image: \"$(IMAGE_REPO):.*\"$$|  image: \"$(IMAGE_REPO):$$new_version\"|" $(SANDBOX_DIR)/spec.yaml > "$$tmp"; \
	mv "$$tmp" $(SANDBOX_DIR)/spec.yaml; \
	mkdir -p $(HOST_PI_PREFIX); \
	npm install --prefix $(HOST_PI_PREFIX) "$(PI_PACKAGE)@$$new_version"; \
	echo "upgrade-pi: pinned $(PI_PACKAGE)@$$new_version"; \
	echo "upgrade-pi: host install refreshed at $(HOST_PI_PREFIX)"
	@# The pin moved, so $(IMAGE) now expands to the new version.
	@$(MAKE) --no-print-directory image
