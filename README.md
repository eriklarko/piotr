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

```bash
make install     # symlink safe-pi and unsafe-pi into ~/.local/bin
safe-pi init     # create ~/.pi-sbx/config and store your GitHub token
```

Then edit `~/.pi-sbx/config`:

```sh
GIT_NAME=Your Name
GIT_EMAIL=you@example.com

# Leave empty to reuse the token from `gh auth token`
GITHUB_TOKEN=

# Local model server (see Offline mode). Empty = use a cloud provider.
OFFLINE_PORT=
OFFLINE_MODEL=
```

Re-run `safe-pi login` after changing the token — global secrets are injected at
sandbox creation, so store the token before the sandbox is created.

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
under `~/.pi-sbx/host-pi/` and is never installed globally.

### Pi version pin

The package version is pinned in [kit/pi-version](kit/pi-version) and baked into
the sandbox install in [kit/spec.yaml](kit/spec.yaml). Bump it with:

```bash
make upgrade-pi              # latest from npm
make upgrade-pi VERSION=0.85.0
```

That updates the pin files and refreshes the host install under
`~/.pi-sbx/host-pi/`. Existing sandboxes keep their old binary until you
recreate them (`safe-pi rm` then `safe-pi`).

### Direct vs clone mode

By default your working tree is mounted read-write at its real absolute path,
and the agent's edits land on your host immediately. `--clone` mounts your
repository read-only and gives the agent a private clone inside the VM instead;
nothing reaches your host until you fetch from the `sandbox-<name>` remote.

Clone mode is fixed at creation. To switch, run `safe-pi rm` first.

## Global extensions, sessions, and memory

### Extensions

Extensions you want in every sandbox go in `~/.pi/agent/extensions/` on the
host — the same place pi looks for global extensions outside a sandbox
(`*.ts` or `*/index.ts`). `safe-pi` mounts that directory read-only into each
sandbox at creation and symlinks the VM's `~/.pi/agent/extensions` to it, so
pi auto-discovers them and `/reload` picks up edits.

Extensions with native `node_modules` built on macOS will not load in the
Linux VM.

### Sessions

Sessions live in `~/.pi/agent/sessions/` on the host, organized by encoded
working directory (`--Users-…-Code-<repo>--/…`). `safe-pi` mounts that
directory read-write into each sandbox and symlinks the VM's
`~/.pi/agent/sessions` to it, so history survives `safe-pi rm` and recreate.

Do not run two sandboxes against the same cwd at once — they would contend on
the same session files.

### Memory

Agent memory (used by packages like `pi-self-learning`) lives in
`~/.pi/memory/` on the host. `safe-pi` mounts it read-write and symlinks the
VM's `~/.pi/memory` to it, so memory persists across sandboxes and recreates.

`settings.json` and `auth.json` stay per-sandbox; only `extensions/`,
`sessions/`, and `memory/` are shared via mounts.

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
set both values in `~/.pi-sbx/config`:

```sh
OFFLINE_PORT=1337
OFFLINE_MODEL=gemma-4-26B-A4B-it-GGUF
```

`safe-pi` then runs `sbx policy allow network localhost:1337` on the host and
writes `~/.pi/agent/models.json` inside the sandbox pointing at
`http://host.docker.internal:1337/v1`. The policy rule targets `localhost`
because the proxy rewrites the hostname before forwarding.

If you change these values after the sandbox exists, apply them with
`safe-pi offline`.

## The kit

[kit/spec.yaml](kit/spec.yaml) defines pi as a custom sandbox agent: base image,
install steps, network allowlist, and the agent context. The pi package version
must match [kit/pi-version](kit/pi-version). Validate with:

```bash
make validate
```

If pi or a tool gets blocked by the network policy, find the domain in
`sbx policy log` and add it to `network.allowedDomains`.

> Kits are experimental. Docker may change the spec format.

## Security model

| Concern | How it's handled |
|---|---|
| Host filesystem and kernel | MicroVM with its own kernel; only the workspace is shared |
| Host Docker daemon | Unreachable; the sandbox has its own engine |
| GitHub token | Stays on the host. The proxy injects it into outbound GitHub requests; `GH_TOKEN` inside the VM is the string `proxy-managed` |
| Network | Deny-by-default HTTP/HTTPS through the host proxy. Raw TCP, UDP, and ICMP are blocked outright |
| Account-level `gh` commands | `gh-guard` wrapper blocks `auth`, `repo`, `secret`, `ssh-key`, `gpg-key` |
| Workspace | Read-write by default; use `--clone` for a hard boundary |

### What this does not protect against

Be clear-eyed about the two soft edges:

**`gh-guard` is a guardrail, not a boundary.** The agent has passwordless sudo
inside the VM and the host proxy authenticates *any* request to
`api.github.com` — including plain `curl`. The wrapper stops casual and
accidental misuse; it cannot stop a determined agent. Scope your token to the
access you are actually willing to grant.

**Direct mode gives the agent your working tree.** It can edit `.git/hooks/`,
`.github/workflows/`, `Makefile`, and IDE task configs — files that execute on
your host during ordinary commits, pushes, and builds. Review agent output like
a pull request from a stranger, or use `--clone`.

Commit signing is disabled inside the sandbox; your signing key never enters
the VM.
