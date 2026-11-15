# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: on the repository page, open the **Security** tab, then
**Report a vulnerability** (GitHub private vulnerability reporting). Include the version (or
commit), the steps to reproduce, and the impact you see. Never include real secrets.

What to expect:

- an acknowledgement within 7 days;
- an assessment and, if the report is confirmed, a fix or a mitigation plan as soon as possible;
- credit in the release notes if you wish.

Vigie is maintained in spare time: these delays are a goal, not a guarantee.

## Supported versions

Only the latest release receives security fixes.

## Scope

Vigie runs on your network and holds read tokens (Proxmox, Gitea, optional services). Its safe
defaults are described in [docs/security.md](docs/security.md): reading requires a session, the
server listens on 127.0.0.1, and the admin login is accepted from the loopback only. Findings that
need one of these defaults to be relaxed are still welcome, but will be weighed accordingly.
