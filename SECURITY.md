# Security policy

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability reporting](https://github.com/FraiseHQ/cla-gate-action/security/advisories/new).
Please do not open a public issue for a security problem.

You should get an acknowledgement within 72 hours.

## Threat model

This action runs on `pull_request_target`, which hands the job a token with
write permissions in the base repository while the pull request is authored by
someone who may be untrusted. Two rules follow, and both are load-bearing:

1. **The action never checks out or executes pull request code.** It reads the
   pull request only through the API. If you wrap this action in a workflow of
   your own, do not add `ref: ${{ github.event.pull_request.head.sha }}` to a
   checkout step in the same job.

2. **The signature token is separate from the workflow token.** Scope
   `signature-token` to contents write on the signature repository and nothing
   else. It should not be a token that can push to the repository being gated.

Signature data — GitHub login, account id, timestamp, and the repository and
number of the pull request where signing happened — is written to a repository
you own. Nothing is sent anywhere else.
