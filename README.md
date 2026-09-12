# pi coding agent (Docker Sandboxes)

Runs the [pi coding agent](https://github.com/badlogic/pi-mono) inside a
[Docker Sandbox](https://docs.docker.com/ai/sandboxes/) — a microVM with its own
kernel, its own Docker daemon, and a deny-by-default network proxy on the host.

The agent gets full autonomy inside the VM. Your host filesystem, your host
Docker daemon, and your credentials stay outside it.

> This replaces an earlier hand-rolled container that relied on a setuid token
> vault, an `LD_PRELOAD` syscall firewall, a Node `fs` monkeypatch, and a
> privilege-binary purge. A hypervisor boundary makes all of that unnecessary.

## Requirements

- [Docker Desktop](https://docs.docker.com/get-started/get-docker/) or Docker Engine
- The `sbx` CLI

```bash
brew trust docker/tap
brew install docker/tap/sbx
sbx login
```

## Setup

This repo is also the source of truth for the pi configuration itself — see
[Configuration in this repo](#configuration-in-this-repo). On a new machine:

```bash
git clone <this-repo> && cd pi-coding-agent-container
make bootstrap
```

`make bootstrap` symlinks the wrappers into `~/.local/bin`, assembles `~/.pi`
out of this repo's `extensions/`, `installed-extensions/`, `skills/` and
`config/` directories, installs the pi packages, and builds the sandbox image.
It is idempotent, so re-running it after a failure is safe. The image step
comes last and needs Docker running and `sbx login` already done.

There is no config file to fill in. The sandbox git identity comes from your
host `git config`, and the GitHub token from `gh auth token`; `GIT_NAME`,
`GIT_EMAIL`, `GITHUB_TOKEN`, `OFFLINE_PORT` and `OFFLINE_MODEL` override those
from the environment if you ever need to.

Two manual steps remain, since neither belongs in git:

```bash
gh auth login      # safe-pi reads the token via `gh auth token`
safe-pi            # then /login inside it, and `safe-pi login` to keep it
```

`safe-pi` stores the GitHub token as an sbx secret itself, at sandbox creation.
Provider credentials you only enter once: run `/login` inside your first
sandbox, then `safe-pi login` saves them to `~/.pi/agent/auth.json`, and every
later sandbox is created with them already in place. Setup never runs pi on the
host.

`make bootstrap` only ever creates symlinks inside `~/.pi`. If one of the
names it wants is already a real file or directory, it aborts with migration
instructions rather than overwriting it, so it can never destroy existing
sessions or memory.

`safe-pi login` is not needed before the first run. Use it to rotate the GitHub
token, and to save a sandbox's provider credentials back to the host. Since
global secrets are injected at sandbox creation, a rotated token reaches
existing sandboxes only on recreate (`safe-pi rm` then `safe-pi`).

Provider credentials refresh inside the sandbox, so the host copy drifts; run
`safe-pi login` again to refresh it. If your provider rotates refresh tokens on
use, a long-lived sandbox can leave the host copy stale — `/login` in a sandbox
and `safe-pi login` recovers it.

## Usage

Run from any project directory. Each directory gets its own sandbox, and
re-running reconnects to it rather than building a second VM.

```bash
cd ~/code/my-project
safe-pi                    # start the pi TUI against $PWD
safe-pi --version          # pass args through to pi
safe-pi 'write a snake game in python'
safe-pi --clone            # agent works on a private in-VM clone
safe-pi --shell            # shell inside the sandbox
safe-pi rm                 # delete this project's sandbox
```

The first run installs Node, pi, and the GitHub CLI inside the VM, so it takes a
minute. Everything after that is cached in the sandbox.

### Unsandboxed host runner

`unsafe-pi` runs the **same pinned** pi package as new sandboxes, but on the
host — full filesystem and network access, no microVM. Use it for debugging
(e.g. downloads blocked by the sandbox allowlist). Prefer `safe-pi` otherwise.

```bash
unsafe-pi                  # kit-pinned pi on the host
unsafe-pi --version
```

Only `safe-pi` and `unsafe-pi` are on your PATH. The pi binary itself lives
under `~/.pi/host-pi/` and is never installed globally.

### Pi version pin

The package version is pinned as `ARG PI_VERSION` in
[docker-sandbox/Dockerfile](docker-sandbox/Dockerfile), which bakes pi into the
sandbox image. That is the single source of truth: the Makefile, `unsafe-pi`
and the image tag in `spec.yaml` all read the pin back out of it rather than
keeping a second copy. Bump it with:

```bash
make upgrade-pi              # latest from npm
make upgrade-pi VERSION=0.85.0
```

That rewrites the pin, refreshes the host install under `~/.pi/host-pi/`,
and rebuilds the sandbox image. Existing sandboxes keep their old image until
you recreate them (`safe-pi rm` then `safe-pi`).

### Direct vs clone mode

By default your working tree is mounted read-write at its real absolute path,
and the agent's edits land on your host immediately. `--clone` mounts your
repository read-only and gives the agent a private clone inside the VM instead;
nothing reaches your host until you fetch from the `sandbox-<name>` remote.

Clone mode is fixed at creation. To switch, run `safe-pi rm` first.

## Configuration in this repo

Pi's configuration is version-controlled here, and `make install` assembles
`~/.pi` from it, so a new laptop is one `make bootstrap`. The repo is organised
by *what a thing is*, not by pi's installation shape:

```
extensions/            extensions written here — mode-controller, scoped-tools
installed-extensions/  pi's npm prefix for third-party packages
  package.json         the manifest (node_modules/ is a platform-native install)
skills/                agent skills, one directory each
config/
  settings.json        theme, package list, per-package config
  keybindings.json
docker-sandbox/        the sbx kit
  spec.yaml            policy: image, env, network allowlist, agent context
  Dockerfile           the sandbox image, and the pi version pin
  gh-guard             the gh wrapper baked in at /usr/local/bin/gh
```

Everything above is tracked. Nothing else belongs here: if a file is
machine-local, generated, or secret, it lives in `~/.pi` instead, which is why
the root `.gitignore` lists nothing but scratch directories and `.DS_Store`.

`extensions/`, `installed-extensions/` and `skills/` each have their own README
or SKILL.md explaining how to add to them.

`~/.pi` is a real directory that pi owns. It has pi's shape, not this repo's,
and holds both the links back to here and pi's own state as real files:

```
~/.pi/
  agent/
    extensions        -> extensions/
    npm               -> installed-extensions/
    skills            -> skills/
    settings.json     -> config/settings.json
    keybindings.json  -> config/keybindings.json
    auth.json            real   provider credentials, copied into each sandbox
    trust.json           real   machine-local trusted paths
    models-store.json    real   regenerated by pi
    sessions/            real   session history
    git/                 real   pi's git-sourced packages
  memory/                real   pi-memory SQLite DB
  plans/                 real   working notes
```

That split is the whole rule: tracked config is a link into the repo, state is
a real file pi writes wherever it likes. `make install` creates only the five
links and `make uninstall` removes only those five, so pi's state is never
something this repo can clobber — and credentials and session history are never
one `git add -A` away from being committed.

The symlinks are required, not cosmetic: third-party packages resolve `~/.pi`
from `homedir()` directly. `@samfp/pi-memory`, for instance, hardcodes
`join(homedir(), ".pi", "memory")` and ignores `PI_CODING_AGENT_DIR`, so
relocating pi's config with that environment variable would desync memory from
everything else.

`safe-pi` reads tracked config from the repo at its real path rather than
through `~/.pi`, so `sbx` never has to resolve a symlink when setting up
mounts; sessions and memory it takes from `~/.pi` directly, where they already
are. One consequence: when you run `safe-pi` from a directory that contains one
of those paths — this repo, or `$HOME` — it is already part of the workspace
mount, so `safe-pi` skips mounting it a second time rather than handing `sbx`
overlapping mounts.

Note that user-level packages are **not** auto-installed by pi — only project
`.pi/settings.json` packages are. That is why `make bootstrap` runs
`npm install` against `installed-extensions/` explicitly.

## Global extensions, sessions, and memory

### Extensions

Extensions you want in every sandbox go in `extensions/`, which is where pi
looks for global extensions outside a sandbox too, via the
`~/.pi/agent/extensions` symlink (`*.ts` or `*/index.ts`). `safe-pi` mounts that directory read-only into each
sandbox at creation and symlinks the VM's `~/.pi/agent/extensions` to it, so
pi auto-discovers them and `/reload` picks up edits.

Extensions with native `node_modules` built on macOS will not load in the
Linux VM.

### Sessions

Sessions live in `~/.pi/agent/sessions/`, organized by encoded
working directory (`--Users-…-Code-<repo>--/…`). `safe-pi` mounts that
directory read-write into each sandbox and symlinks the VM's
`~/.pi/agent/sessions` to it, so history survives `safe-pi rm` and recreate.

Do not run two sandboxes against the same cwd at once — they would contend on
the same session files.

### Memory

Agent memory (used by packages like `@samfp/pi-memory`) lives in
`~/.pi/memory/`. `safe-pi` mounts it read-write and symlinks the
VM's `~/.pi/memory` to it, so memory persists across sandboxes and recreates.

`settings.json` stays per-sandbox. `auth.json` is *seeded* from the host copy at
creation and writable in the VM thereafter — a copy, not a mount, so a sandbox
refreshing its credentials does not write to the host. Only `extensions/`,
`sessions/`, and `memory/` are genuinely shared via mounts.

#### Embedder model

Packages like `@samfp/pi-memory` rank memories semantically using a local
`all-MiniLM-L6-v2` ONNX model, which `@xenova/transformers` downloads from
Hugging Face on first use. Hugging Face is not in the kit allowlist, so that
download would normally be blocked and memory would silently fall back to
keyword-only search.

Instead, `safe-pi` downloads the model once, at sandbox creation, right after it
installs your packages:

1. adds a **sandbox-scoped** allow rule for `huggingface.co` and `**.hf.co`
   (the weights redirect to a region-specific CDN such as `us.aws.cdn.hf.co`),
2. runs a one-shot warm-up inside the VM to populate the model cache (~23 MB),
3. removes the rule again — via a shell trap, so it is also removed if the
   download fails or you interrupt it.

The rule exists for a couple of seconds during creation and is gone before the
agent ever receives a prompt, so **the agent never runs with Hugging Face
reachable**. Nothing is added to `docker-sandbox/spec.yaml`, and no host directory is
mounted — the model is fetched inside the VM into whatever cache path
`@xenova/transformers` chooses.

The step is skipped entirely unless `pi-memory` appears in your host
`packages` list, and a failed download is a warning rather than an error: you
get today's keyword-only behaviour, not a broken sandbox. `safe-pi sync` warms
the cache too, for sandboxes that predate the package.

If pi-memory ever switches models, update `EMBEDDER_MODEL` in `safe-pi` to
match, or warm-up will cache a file it does not use.

Mounts are fixed at creation, so sandboxes created before these directories
were wired up need their data copied out first, then `safe-pi rm` followed by
`safe-pi`:

```bash
mkdir -p ~/.pi/agent/sessions ~/.pi/memory
sbx cp <sandbox>:/home/agent/.pi/agent/sessions/. ~/.pi/agent/sessions/
sbx cp <sandbox>:/home/agent/.pi/memory/. ~/.pi/memory/
```

### Packages

Packages you installed globally on the host (`unsafe-pi install npm:...`, or
listed under `packages` in `~/.pi/agent/settings.json`) are mirrored too, but
not by mounting: the host's `~/.pi/agent/npm/` is a macOS `node_modules` tree. At
creation `safe-pi` runs `pi install` for each host package inside the VM and
copies the `packages` list over, filters included. Local-path packages are
skipped since the path does not exist in the VM.

This is a snapshot, not a live mount. After installing or removing packages on
the host, run `safe-pi sync` in each project to update its sandbox.

## Offline mode (local models)

`localhost` inside the sandbox is the VM's own loopback, **not** your machine.
A model server on your host is reachable at `host.docker.internal`, and only
after you allow it through the proxy.

Start your server (llama.cpp, Ollama, Docker Model Runner, …) on the host, then
pass both values in the environment:

```sh
export OFFLINE_PORT=1337
export OFFLINE_MODEL=gemma-4-26B-A4B-it-GGUF
safe-pi          # or `safe-pi offline` for a sandbox that already exists
```

`safe-pi` then runs `sbx policy allow network localhost:1337` on the host and
writes `~/.pi/agent/models.json` inside the sandbox pointing at
`http://host.docker.internal:1337/v1`. The policy rule targets `localhost`
because the proxy rewrites the hostname before forwarding.

If you change these values after the sandbox exists, apply them with
`safe-pi offline`.

## The kit

[docker-sandbox/spec.yaml](docker-sandbox/spec.yaml) defines pi as a custom
sandbox agent, and holds policy only: the image to boot, environment
variables, the network allowlist, and the agent context.

The tools themselves — pi, a pinned `gh`, the `gh-guard` wrapper, the git
credential helper — are baked into an image by
[docker-sandbox/Dockerfile](docker-sandbox/Dockerfile) instead of installed per
sandbox. Adding a tool means adding a Dockerfile line, not another install
step in the manifest, and creating a sandbox downloads nothing.

`sbx` keeps its own image store, separate from the host Docker daemon, so the
image has to be built *and* loaded:

`make bootstrap` does this for you on a new machine. To rebuild after editing
the Dockerfile:

```bash
make image        # docker build, then docker save | sbx template load
make validate     # kit spec, pin, and that the tagged image is in the store
```

The image tag carries the pi version (`pi-sandbox:0.85.1`), so a stale image
cannot masquerade as a current one; `make validate` fails if `spec.yaml` and
the Dockerfile pin disagree. If the image was never built, `safe-pi` refuses to
create a sandbox and points at `make image`, rather than letting `sbx` mistake
the tag for a registry reference and fail with a bare 403.

If pi or a tool gets blocked by the network policy, find the domain in
`sbx policy log` and add it to `network.allowedDomains`.

> Kits are experimental. Docker may change the spec format.

## Security model

| Concern | How it's handled |
|---|---|
| Host filesystem and kernel | MicroVM with its own kernel; only the workspace is shared |
| Host Docker daemon | Unreachable; the sandbox has its own engine |
| GitHub token | Stays on the host. The proxy injects it into outbound GitHub requests; `GH_TOKEN` inside the VM is the string `proxy-managed` |
| Network | Deny-by-default HTTP/HTTPS through the host proxy. Raw TCP, UDP, and ICMP are blocked outright. Hugging Face is opened briefly at creation to cache the embedder model, then closed before the agent starts (see [Embedder model](#embedder-model)) |
| Provider credentials | **Not protected.** `auth.json` is copied into the VM, so the real model-provider key is present there — unlike the GitHub token. Scope it accordingly |
| Account-level `gh` commands | `gh-guard` wrapper blocks `auth`, `repo`, `secret`, `ssh-key`, `gpg-key` |
| Workspace | Read-write by default; use `--clone` for a hard boundary |

### What this does not protect against

Be clear-eyed about the three soft edges:

**`gh-guard` is a guardrail, not a boundary.** The agent has passwordless sudo
inside the VM and the host proxy authenticates *any* request to
`api.github.com` — including plain `curl`. The wrapper stops casual and
accidental misuse; it cannot stop a determined agent. Scope your token to the
access you are actually willing to grant.

**Your provider key is inside the VM.** `auth.json` is copied in at creation, so
anything running in the sandbox can read it — the proxy trick that keeps the
GitHub token out does not apply, because pi authenticates to the model provider
itself. This is a deliberate trade for one `/login` instead of one per sandbox.
Use a key you are willing to have on a machine the agent controls.

**Direct mode gives the agent your working tree.** It can edit `.git/hooks/`,
`.github/workflows/`, `Makefile`, and IDE task configs — files that execute on
your host during ordinary commits, pushes, and builds. Review agent output like
a pull request from a stranger, or use `--clone`.

Commit signing is disabled inside the sandbox; your signing key never enters
the VM.
