# installed-extensions

Third-party pi packages, installed from npm. This directory *is* pi's npm
prefix: `make install` links `~/.pi/agent/npm` here, and pi loads globally
installed packages from that one fixed location. `package.json` is the tracked
manifest; `node_modules/` and `package-lock.json` are gitignored because the
install is platform-native.

Contrast with [`../extensions/`](../extensions), which holds the extensions
written in this repo. Those are loaded as source; these are npm dependencies.

## Adding a package

Either way works — pick one and keep `package.json` the source of truth:

```bash
# 1. Let pi do it (requires ~/.pi to be linked here, i.e. make install has run)
pi install npm:<package>

# 2. Or edit package.json by hand, then
make bootstrap        # runs npm install --prefix installed-extensions
```

A package also has to be listed in `packages` in
[`../config/agent/settings.json`](../config/agent/settings.json) for pi to
actually load it, and `safe-pi` reads that same list to install the packages
inside each sandbox at creation time. After changing it, run `safe-pi sync` on
existing sandboxes.

## Where package settings live

Not here. Pi has exactly one settings file, so a package's runtime config
cannot sit next to the package — it goes in `config/agent/settings.json` under
a top-level key named after the package. For example `pi-tldr` reads:

```json
{
  "tldr": {
    "model": "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"
  }
}
```

So adding a package usually touches two files: `package.json` here, and
`config/agent/settings.json` for both the `packages` entry and any config.
