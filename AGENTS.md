<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

- Read `README.md` and `docs/architecture.md` before changing gameplay.
- Keep authoritative transitions in `lib/game/engine.ts`, not React components.
- Never expose `sessions.state`, host PIN hashes, or unrevealed answers to browsers.
- Use atomic compare-and-swap persistence; never use process memory for buzzer ownership or timers.
- Preserve durable sessions and the host Resume/Continue flow across every phase.
- Run `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, and the affected Playwright tests before delivery.
- Keep deployment secrets in environment variables; `.env.example` contains placeholders only.
