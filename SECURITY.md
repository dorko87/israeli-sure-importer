# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, **please do not open a public
GitHub issue**. Public disclosure before a fix is available puts all users at risk.

Instead, report it privately:

- **GitHub:** Use [GitHub's private vulnerability reporting](https://github.com/dorko87/israeli-sure-importer/security/advisories/new)
- **Email:** Open a GitHub issue asking for a private contact channel if the above is unavailable

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested mitigations if you have them

You can expect an acknowledgement within 48 hours and a status update within 7 days.

## Scope

This project runs entirely on your own hardware - no data is sent to third parties
except the Israeli banks being scraped and Telegram (for alerts). The attack surface
is limited to:

- The Docker container and its host mounts
- The `secrets/` directory on your host
- The Sure Finance API endpoint you configure

Credentials are never logged, never written to disk (except in the Docker secrets
mount you control), and never transmitted beyond the configured endpoints.
