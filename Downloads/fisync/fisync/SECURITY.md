# Security policy

## Supported versions

Only the latest release receives security fixes. Update fisync on the computer and the phone.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting:
the **Security** tab of the repository, then **Report a vulnerability**.

Include what you found, the version, the steps to reproduce it, and what an attacker could do with it.
A proof of concept is welcome but not required.

We will acknowledge reports as soon as we can and keep you informed while the fix is prepared.
This is a small project, so we cannot promise fixed response times.

## Scope

In scope: the computer app, the phone app, the browser phone page, the relay, the pairing and encryption protocol, and the release files.

Out of scope: problems that need malware already running on the computer or the phone, and weaknesses in Tailscale, Android, Windows, macOS or Linux themselves (report those to their makers).

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for what fisync is designed to protect against, and what it does not protect against.
