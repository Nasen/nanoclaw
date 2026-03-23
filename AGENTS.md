# Repository Guidelines

## Project Structure & Module Organization

- `src/`: host-side TypeScript app, channel integrations, container orchestration, setup/runtime config.
- `container/agent-runner/`: code that runs inside the agent container, including provider implementations.
- `setup/`: direct host setup flow for environment, service, container runtime, and verification.
- `groups/`: registered group data checked by the host runtime.
- `data/`: runtime state, sessions, IPC, and local database artifacts.
- `logs/`: service logs such as `logs/nanoclaw.log`.

## Build, Test, and Development Commands

- `npm run build`: compile the host app to `dist/`.
- `npm run typecheck`: run TypeScript checks without emitting files.
- `npm test`: run the Vitest test suite once.
- `npm run test:watch`: run tests in watch mode.
- `npm run dev`: start the host app with `tsx` for local development.
- `npm run setup -- --step verify`: verify service, container runtime, credentials, and channels.
- `docker build -t nanoclaw-agent-v3:latest container/`: rebuild the agent image when changing `container/agent-runner/`.

## Coding Style & Naming Conventions

- Language: TypeScript with ES modules.
- Formatting: Prettier is used via `npm run format:fix`.
- Indentation: follow existing style in the repo; keep edits consistent with surrounding code.
- File names use kebab-case or descriptive module names such as `container-config.ts`, `credential-proxy.ts`.
- Prefer small, focused functions and explicit names over abbreviations.

## Testing Guidelines

- Framework: Vitest.
- Test files usually live beside source files and use `*.test.ts`.
- Add or update tests for behavior changes in `src/` and `container/agent-runner/` when practical.
- Before merging, at minimum run `npm run typecheck` and the relevant Vitest targets.

## Commit & Pull Request Guidelines

- Use concise conventional-style commit messages, for example:
  - `feat: add pluggable agent backend support`
  - `fix: stabilize OpenAI tool execution and web fetch`
  - `docs: add direct setup path for OpenAI backend`
- Keep PRs focused. Separate docs, setup fixes, and backend/runtime changes when possible.
- PRs should describe user-visible behavior, config changes, and any required rebuild or restart steps.

## Security & Configuration Tips

- Do not commit real secrets from `.env`.
- If `CONTAINER_IMAGE` is overridden in `.env`, rebuild that exact tag before restarting the service.
- For OpenAI web tools in intercepted-TLS environments, prefer `WEB_FETCH_CA_BUNDLE`; use `WEB_FETCH_INSECURE_TLS=true` only as a fallback.
