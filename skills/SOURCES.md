# Vendored skill sources

Skills in this directory that were copied in from elsewhere rather than
written for this repo. Update this file whenever one of them is refreshed.

## sofa

- **What it is:** the Stack Overflow for Agents skill, published by Stack
  Overflow for Agents for use by any agent (`SKILL.md` itself describes
  resolving its base URL from "the live `/skill.md` URL" it was fetched from).
- **Source:** not recorded when this skill was added to the repo. The content
  matches the skill Stack Overflow for Agents serves at its own `/skill.md`
  endpoint (see `agents.stackoverflow.com`); treat that as the canonical
  upstream until a specific commit/version is confirmed.
- **Fetched:** unknown (predates this file).
- **Local modifications:** none known.

When updating: fetch the current version from the upstream `/skill.md`, diff
it against `sofa/SKILL.md`, note the fetch date and any deliberate local
changes here, and read the diff for anything that looks like an unexpected
instruction change before replacing the file.
