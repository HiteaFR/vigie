# Contributing to Vigie

Thanks for your interest. Vigie is a small project maintained in spare time: issues and pull
requests are welcome, and reviewed when time allows.

## Before you start

- **Bugs**: open an issue with the bug template (version, what you did, what you expected, what
  happened, logs without secrets).
- **Ideas**: open an issue with the idea template before writing code, so we can agree on the
  approach. Vigie stays read-mostly: actions that change the monitored systems (SSH terminals,
  container control) are out of scope.
- **Security issues**: never in a public issue. See [SECURITY.md](SECURITY.md).

## Development

See [docs/development.md](docs/development.md) for the architecture and the local setup.

```bash
cd client && npm ci && npm run lint
cd ../server && npm ci && npm test
```

- `npm test` (in `server/`) runs every test, including real renders of the client: install the
  client first. No test may be skipped (the CI checks for `# skipped 0`).
- The interface is translated: every text goes through the catalogs (`server/locales`,
  `client/src/i18n`, and `locales/` next to each plugin), in English and French, with the same keys.
- Plugins: see [docs/plugins.md](docs/plugins.md).
- Dependencies: add one only when it is really needed, and say why in the pull request.

## Pull requests

- One topic per pull request, with tests for the behavior you change.
- Keep the existing style: plain JavaScript (ES modules), no build step on the server.
- Fill in the pull request template.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
(DCO). By signing off a commit, you certify that you wrote it, or otherwise have the right to submit
it under the project's license (Apache-2.0).

Add a `Signed-off-by` line to every commit, with your real name and an email address you can be
reached at:

```
Signed-off-by: Jane Doe <jane@example.net>
```

`git commit -s` adds it for you. A pull request whose commits are not all signed off cannot be
merged.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
