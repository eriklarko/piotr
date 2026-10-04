# skills

Agent skills, one directory per skill. `make install` links this directory to
`~/.pi/agent/skills`, and `safe-pi` mounts it read-only into every sandbox (or
copies it in, if the workspace itself contains this repo — see
[Skills](../README.md#skills) in the root README), so anything added here is
available in every project without per-project setup.

## Skill layout

pi discovers a skill from `skills/<name>/SKILL.md`. The frontmatter fields
used in this repo:

```yaml
---
name: my-skill
description: One or two sentences a model uses to decide when to invoke this
  skill, and what it does. Be specific about triggers.
disable-model-invocation: true # optional: only reachable via /skill my-skill
---
```

`disable-model-invocation` is set on skills that should not fire on the
model's own judgement — `morning-summary` and `write-pr-description` in this
repo, both invoked explicitly.

A skill can bundle its own files next to `SKILL.md` — `morning-summary/scripts/`
is an example, a small Node project with its own `package.json`.

## Adding a custom skill

1. `mkdir skills/<name>`, write `skills/<name>/SKILL.md`.
2. If it needs helper scripts, put them in `skills/<name>/scripts/` with their
   own `package.json` if they have npm dependencies — `make bootstrap` (or
   `make skills-deps`) installs them on the host automatically (see below).
3. Test it in a sandbox before relying on it: `safe-pi`, then `/skill <name>`
   or let the model invoke it if `disable-model-invocation` is unset.

### Skills that run scripts need a shell

A skill's own instructions (`SKILL.md`) can only ever call tools the agent
already has active. Running `node scripts/foo.mjs` needs `bash`, which today
only [`danger` mode](../extensions/mode-controller/modes/danger.md) has (see
[mode-controller](../extensions/mode-controller/README.md)). `morning-summary`
is in this position: it is unusable in `ask`/`plan`/`build`. Until a narrower
scoped tool exists for running trusted, repo-local scripts, either accept that
a script-based skill only works from `danger` mode, or write it so its
guidance is followable with the tools a narrower mode already has (`read`,
`grep`, `edit`, `git_*`, ...).

### Dependencies

If `skills/<name>/scripts/package.json` exists, `make bootstrap` (or
`make skills-deps` on its own) runs `npm install` there — on the **host**.
Unlike `installed-extensions/`, this is not reinstalled inside the VM: `skills/`
reaches the sandbox as a read-only mount (or a read-only copy, see the root
README), so whatever `node_modules/` sits here when the sandbox is created or
`safe-pi sync` runs is what the sandbox gets. That is only safe for pure-JS
dependencies with no native addons — the same caveat `extensions/` has for
native `node_modules` built on macOS applies here too. `node_modules/` and
`package-lock.json` under `scripts/` are not tracked — see the pattern in
`morning-summary/scripts/.gitignore`.

Secrets a skill's scripts need (e.g. `morning-summary`'s `LINEAR_API_KEY`) are
not provisioned by `safe-pi`. Export them in the sandbox shell, or `sbx exec`
them in before running the skill; do not commit them.

## Adding a third-party / vendored skill

Skills copied in from elsewhere (`sofa` in this repo is an example) have no
package manager to pin a version, so record where they came from and when, in
[`SOURCES.md`](SOURCES.md), so a future update or audit knows what to diff
against. Do not silently edit a vendored skill's `SKILL.md` in place beyond
what `SOURCES.md` records — note the change there too.

Read a vendored skill's contents before trusting it: `SKILL.md` runs with the
same authority as your own instructions, and a copied-in skill is not
something you wrote.

## Network access

A skill's `SKILL.md` cannot itself add to the sandbox's network allowlist. If
a skill needs a new domain (an API it calls directly, not through `gh` or an
already-allowed host), add it to `caps.network.allow` in
[`../docker-sandbox/spec.yaml`](../docker-sandbox/spec.yaml).
