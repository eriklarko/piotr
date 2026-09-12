# syntax=docker/dockerfile:1
#
# The sandbox image for the pi agent. Everything that used to be a
# `commands.install` step in spec.yaml is baked in here, so spec.yaml stays
# pure policy and creating a sandbox downloads nothing.
#
# Build it with `make image`: sbx keeps its own image store, so a plain
# `docker build` on the host daemon is not enough to make it usable.
FROM docker/sandbox-templates:shell

# Single source of truth for the pi version. `make upgrade-pi` rewrites this
# line, and the Makefile reads it back out for the image tag, the spec.yaml
# image reference and the host-side install.
ARG PI_VERSION=0.85.1
ARG GH_VERSION=2.83.0
# Set by buildx. "amd64" or "arm64" — also how gh names its release assets.
ARG TARGETARCH

# Set once so every RUN below can be a plain command: -e stops on the first
# failure, -u on an unset variable, pipefail on a failed curl feeding tar.
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
USER root

# The base template ships its own Node. Assert instead of installing one: a
# silent downgrade would surface as a confusing pi failure much later.
RUN node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error(`need node >= 22, image has ${process.version}`); process.exit(1); }'

# Private-prefix install (not on PATH). The kit entrypoint names the binary.
RUN npm install --prefix /usr/lib/pi-kit/pi "@earendil-works/pi-coding-agent@${PI_VERSION}"

# A pinned gh, parked off PATH as gh-real. Only the wrapper below calls it.
RUN mkdir -p /usr/lib/pi-kit
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH:?}.tar.gz" \
      | tar -xzO "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" > /usr/lib/pi-kit/gh-real \
 && chmod 0755 /usr/lib/pi-kit/gh-real

# The wrapper has to be the only gh reachable by name — with a second gh
# anywhere on PATH the guard is sidestepped by typing that path instead.
RUN rm -f /usr/bin/gh /usr/local/bin/gh
COPY --chmod=0755 gh-guard /usr/local/bin/gh
RUN [ "$(type -ap gh | wc -l)" = 1 ]

# git takes its GitHub credentials from gh, which the host proxy authenticates.
RUN install -d -o agent -g agent /home/agent/.pi /home/agent/.pi/agent
RUN su agent -c 'git config --global credential.https://github.com.helper "!/usr/local/bin/gh auth git-credential"'

USER agent
