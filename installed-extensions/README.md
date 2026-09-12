# installed-extensions

Third-party pi packages, installed from npm. This directory *is* pi's npm
prefix: `make install` links `~/.pi/agent/npm` here, and pi loads globally
installed packages from that one fixed location. `package.json` and
`package-lock.json` are tracked and pin exact versions (no `^`/`~` ranges) —
a sandbox installs the same version the host resolved, not whatever is newest
on npm that day (see `safe-pi`'s `sync_packages`). `node_modules/` itself is
still gitignored, since the install is platform-native.

Contrast with [`../extensions/`](../extensions), which holds the extensions
written in this repo. Those are loaded as source; these are npm dependencies.

## Adding a package

Either way works — pick one, land on an exact version (not a range), and keep
`package.json`/`package-lock.json` the source of truth:

```bash
# 1. Let pi do it (requires ~/.pi to be linked here, i.e. make install has run;
# pi itself is not on PATH outside a sandbox, so go through unsafe-pi)
unsafe-pi install npm:<package>@<version>

# 2. Or edit package.json by hand with an exact version, then
make bootstrap        # runs npm install --prefix installed-extensions
```

A package also has to be listed in `packages` in
[`../config/settings.json`](../config/settings.json) for pi to actually load
it, and `safe-pi` reads that same list — pinned to the version in this
directory's `package.json` — to install the package inside each sandbox at
creation time. After changing it, run `safe-pi sync` on existing sandboxes.

If the package registers new tools, list them in the relevant mode(s) under
[`../extensions/mode-controller/modes/`](../extensions/mode-controller/modes)
— mode-controller is deny-by-default, so an unlisted tool is blocked
everywhere, package or not.

## Where package settings live

Not here. Pi has exactly one settings file, so a package's runtime config
cannot sit next to the package — it goes in `config/settings.json` under
a top-level key named after the package. For example `pi-tldr` reads:

```json
{
  "tldr": {
    "model": "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"
  }
}
```

`safe-pi` copies every such key (everything except `packages` and
`lastChangelogVersion`) into each sandbox's settings — see `sync_package_config`.

So adding a package usually touches two files: `package.json` here, and
`config/settings.json` for both the `packages` entry and any config.
