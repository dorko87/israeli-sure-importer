## What's new in v1.2.0

### Improvements
- **`LOG_MAX_FILES` env var** — Log retention window is now configurable via `LOG_MAX_FILES` in `compose.yml` (e.g. `"7d"`, `"14d"`). Defaults to `7d`. Previously hardcoded to 14 days.
