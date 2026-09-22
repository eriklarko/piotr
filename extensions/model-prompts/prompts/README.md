# Model prompt files

Add non-recursive `*.md` files to this directory to append guidance for matching models. Run `/reload` after adding or editing a file.

Each file has a non-empty `models` array of JavaScript regex strings followed by the prompt text:

```markdown
---
models:
  - '.*openai.*'
  - '.*gpt-5\.6-sol.*'
---
Guidance appended to the system prompt for matching models.
```

Patterns are case-insensitive and are matched against Pi's canonical `provider/model-id` label, such as `amazon-bedrock/global.openai.gpt-5.6-sol`. A file activates when any pattern matches. If multiple files activate, their prompt bodies are appended in lexical filename order.

`README.md` is ignored by the loader. Files with invalid frontmatter, regexes, or empty prompt bodies are skipped and reported as warnings.
