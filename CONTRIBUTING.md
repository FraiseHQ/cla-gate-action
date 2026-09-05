# Contributing

Thanks for considering it.

## No CLA here

This repository does not require a contributor licence agreement, which would
be a strange thing to demand of people helping with a CLA tool. Contributions
are accepted under the same MIT licence the project is released under
(inbound equals outbound). By opening a pull request you confirm you have the
right to submit the work.

## Getting set up

Node 22.18 or later. There are no runtime dependencies and no build step —
Node runs the TypeScript directly.

```sh
npm ci
npm run typecheck
npm test
```

## Running it against a real repository

```sh
GH_TOKEN=$(gh auth token) \
GITHUB_REPOSITORY=owner/repo \
SIG_REPO=owner/signatures \
SIG_TOKEN=$(gh auth token) \
CLA_URL=https://example.com/CLA.md \
  node src/cla.ts check 42
```

`GITHUB_API_URL` overrides the API root, which is how the tests point the same
code at a stub server.

## Conventions

- No runtime dependencies. This is deliberate — a CLA gate that pulls a
  dependency tree is a supply chain risk sitting on a `pull_request_target`
  trigger with write permissions.
- `erasableSyntaxOnly` is on, so no enums, namespaces, or parameter
  properties. If it typechecks, Node can run it unmodified.
- Every behavioural change needs a test in `test/cla.test.ts`. The mock server
  in `test/mock-github.ts` asserts which token each endpoint is called with, so
  a credential mix-up fails the suite rather than passing quietly.

## Releases

Releases are cut by [release-please](https://github.com/googleapis/release-please)
from [conventional commits](https://www.conventionalcommits.org/). Merging to
`main` updates a release pull request; merging *that* tags the release and
publishes it.

Prefix commits with `feat:`, `fix:`, `docs:`, `perf:`, `deps:`, `refactor:`,
`test:`, `ci:` or `chore:`. The first three show up in the changelog.

This project bumps the major version on every release, so tags run
`v1.0.0`, `v2.0.0`, `v3.0.0`. Tags are immutable: there is no moving `vN` tag,
so consumers pin an exact version.
