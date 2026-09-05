# cla-gate-action

Require contributors to sign a CLA before merge. Signatures live in a
repository you own — no hosted service, no OAuth grant, no third party holding
your contributor records.

- **No runtime dependencies.** Node runs the TypeScript directly; there is no
  bundled `dist/` to trust or rebuild.
- **The gate is a commit status**, written explicitly against the pull
  request's head SHA. It cannot go green because a job exited zero.
- **Signatures are yours.** A JSON file in your repository, in git history,
  greppable, portable.

## Quick start

Create a repository for signatures — private is fine — with `signatures.json`
on its default branch:

```json
{ "signatures": [] }
```

Add a fine-grained PAT with **Contents: read and write** on that repository
only, as a secret named `CLA_SIGNATURES_TOKEN` in the repository you want to
gate. Then `.github/workflows/cla.yml`:

```yaml
name: CLA

on:
  pull_request_target:
    types: [opened, reopened, synchronize]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  statuses: write

jobs:
  cla:
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event.issue.pull_request != null &&
       contains(github.event.comment.body, 'I have read the CLA Document and I hereby sign the CLA'))
    runs-on: ubuntu-latest
    steps:
      - uses: FraiseHQ/cla-gate-action@v1.0.0
        with:
          cla-url: https://github.com/your-org/your-repo/blob/main/CLA.md
          signature-repo: your-org/cla-signatures
          signature-branch: main
          signature-token: ${{ secrets.CLA_SIGNATURES_TOKEN }}
```

Finally, in branch protection, require the **`cla/signed`** status check.

> Require the status context, not the job name. The job finishes successfully
> after posting "please sign" — if branch protection watches the job, it turns
> green while the CLA is unsigned. This is the single most common way a CLA
> workflow silently stops gating anything.

## How it works

A contributor opens a pull request. The action resolves every commit author,
compares them against the signature file, and writes the `cla/signed` status
against the head SHA. If anyone is missing it posts one comment naming them.

The contributor replies with the exact phrase. The `issue_comment` trigger fires,
the signature is appended to the file in your signature repository, and the same
run re-checks and flips the status to success.

Signatures record the account id as well as the login, so a later rename can't
produce a duplicate, and lookups are case insensitive because GitHub logins are.

## Allowlist

Some accounts should never be asked. Put `allowlist.json` next to
`signatures.json`:

```json
{
  "entries": [
    { "login": "your-username", "reason": "project owner and copyright holder" },
    { "login": "*[bot]", "reason": "GitHub Apps; the [bot] suffix is reserved by GitHub" }
  ]
}
```

`*` globs, case insensitive. `*[bot]` is a safe catch-all because GitHub
reserves that suffix for apps — a person cannot register a login containing
brackets. If the file doesn't exist you get `*[bot]` by default. The `reason` is
printed in the run log when someone is skipped, so the decision explains itself
a year later.

Allowlisting a *person* means no licence grant from them. That's usually right
for the copyright holder and wrong for everyone else.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `cla-url` | — | **Required.** Link to the CLA text. |
| `token` | `github.token` | Reads the PR, writes the status and comment. |
| `signature-repo` | this repo | Where signatures live. |
| `signature-token` | `token` | Needs contents:write on `signature-repo`. |
| `signature-branch` | `main` | |
| `signature-path` | `signatures.json` | |
| `allowlist-path` | `allowlist.json` | Missing file is not an error. |
| `allowlist` | — | Extra entries, space separated, merged with the file. |
| `status-context` | `cla/signed` | The context to require in branch protection. |
| `fail-on-unsigned` | `true` | Set false to gate on the status alone. |
| `node-version` | `24` | Needs >= 22.18. |

### Outputs

| Output | |
| --- | --- |
| `signed` | `"true"` when everyone is signed or allowlisted. |
| `missing` | Space separated logins still needing to sign. |

## Same-repository signatures

Leave `signature-repo` and `signature-token` unset and signatures land in the
gated repository itself, using `GITHUB_TOKEN`. Point `signature-branch` at an
orphan branch so the file stays out of your main history:

```sh
git switch --orphan cla-signatures
git rm -rf .
echo '{"signatures":[]}' > signatures.json
git add signatures.json && git commit -m "cla: initialise signature store"
git push -u origin cla-signatures
```

You'll also need `contents: write` in the workflow's `permissions`.

A separate repository is better once you gate more than one repo, since a
contributor then signs once for the organisation.

## Running it locally

The API root comes from `GITHUB_API_URL`, so the same code runs against the
real API from your laptop:

```sh
GH_TOKEN=$(gh auth token) \
GITHUB_REPOSITORY=your-org/your-repo \
SIG_REPO=your-org/cla-signatures \
SIG_TOKEN=$(gh auth token) \
CLA_URL=https://example.com/CLA.md \
  node src/cla.ts check 42
```

`check <pr>`, `sign <pr> <login> <user-id>` and `allowlist` are the three
subcommands. Reproducing a CI decision on your own machine beats pushing
commits to find out.

## Security

`pull_request_target` runs with write permissions against a pull request an
untrusted person authored. This action never checks out or executes pull
request code — it reads everything through the API. If you write your own
wrapper workflow, do not add `ref: ${{ github.event.pull_request.head.sha }}`
to a checkout in the same job.

Scope `signature-token` to contents write on the signature repository and
nothing else. See [SECURITY.md](SECURITY.md).

## A note on tokens

A fine-grained PAT cannot live longer than a year, and when it expires the sign
step starts failing with a 403. The durable alternative is a GitHub App
installed on your organisation with contents write on the signature repository,
minted per run with `actions/create-github-app-token`, passed as
`signature-token`.

## Licence

MIT.
