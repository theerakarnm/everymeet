# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through the "Report a vulnerability" button on the Security tab of this repository (GitHub private vulnerability reporting).
Do not open a public issue for a vulnerability.

Please include:

- the version or commit you tested,
- the steps to reproduce the problem,
- the impact you expect (what an attacker can read, change, or break).

We aim to reply within 7 days; this is a goal, not a promise.

## Supported versions

Only the latest `main` is supported.

## Scope

In scope: the engine in this repository, which is the web pages, the HTTP API, the webhooks, and the recorder Worker and container in `meet/`.
Out of scope: the hosted service built on this engine, which has its own reporting channel.
