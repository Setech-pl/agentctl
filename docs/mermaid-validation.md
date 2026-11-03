# Mermaid validation

Run `npm run docs` and `npm run docs:mermaid` before committing documentation.
The validator checks every Mermaid fence in root README*.md and recursively in docs/**/*.md, reporting the file and opening fence line on failure. CI runs it on macOS with Node 22.14 and latest Node.

Mermaid and JSDOM are development dependencies only. Parsing avoids downloading Chromium and starting a browser per diagram, reducing CI startup time and installation size compared with Mermaid CLI. JSDOM supplies the DOM needed by Mermaid's sanitization. The lockfile pins the dependency graph. Parsing checks syntax, not visual layout or GitHub's exact Mermaid version; duplicate sequence participant aliases are also rejected explicitly.

README.md is the canonical diagram source. The docs generator copies its diagrams into docs/diagrams.md; Polish diagrams remain translated in README.pl.md.

The ordering-agent section follows “How it works” so dispatch decisions precede daily operation. Notifications belong in their own section; License ends both READMEs. Examples use generic project names and paths.
