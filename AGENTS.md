<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:fireafter-pkg-rules -->
## FireAfter Project Knowledge Graph

`pkg.json` at the project root is the authoritative project map. Before any code, schema, config, dependency, or route change:

1. Read `pkg.json`.
2. Identify touched nodes and downstream edges.
3. State impact analysis, architectural fit, and tests to run before editing.
4. After accepted changes, update `pkg.json` with new or changed files, functions, components, APIs, data models, config, edges, and drift risks.

Do not store secret values in the PKG. Track environment variable names only.
<!-- END:fireafter-pkg-rules -->
