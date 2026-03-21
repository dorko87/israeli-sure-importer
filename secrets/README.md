# secrets/

This directory holds credential files for `israeli-banks-sure-importer`.

**These files are gitignored.** Never commit them.

---

## Rules

- One file = one value. The file contains only the raw credential — no key name, no quotes, no trailing newline.
- Each file must be `chmod 400` (owner read-only).
- All files are mounted read-only at `/run/secrets/` inside the container.

---

## How to create them

Use the interactive wizard:

```bash
bash setup.sh
```

Or create manually:

```bash
# Format: printf '%s' "VALUE" > secrets/<filename> && chmod 400 secrets/<filename>
printf '%s' "your-sure-api-key" > secrets/sure_api_key && chmod 400 secrets/sure_api_key
printf '%s' "your-telegram-token" > secrets/telegram_bot_token && chmod 400 secrets/telegram_bot_token
printf '%s' "yourBankUsername" > secrets/leumi_username && chmod 400 secrets/leumi_username
printf '%s' "yourBankPassword" > secrets/leumi_password && chmod 400 secrets/leumi_password
```

---

## Required files

| File | Env var pointing to it | Description |
|------|----------------------|-------------|
| `sure_api_key` | `SURE_API_KEY_FILE` | Sure Finance API key — Settings → API Keys |
| `telegram_bot_token` | `TELEGRAM_BOT_TOKEN_FILE` | Telegram bot token — optional |

## Per-bank credential files

The filename for each bank credential is set in `config.json` under
`targets[].credentialSecrets`. For example:

```json
"credentialSecrets": {
  "username": "leumi_username",
  "password": "leumi_password"
}
```

This means the container will read `/run/secrets/leumi_username` and `/run/secrets/leumi_password`.

### Credential field names by bank

| companyId | Required fields |
|-----------|----------------|
| `hapoalim` | `userCode`, `password` |
| `leumi` | `username`, `password` |
| `discount` | `id`, `password`, `num` |
| `mercantile` | `id`, `password`, `num` |
| `mizrahi` | `username`, `password` |
| `otsarHahayal` | `username`, `password` |
| `beinleumi` | `username`, `password` |
| `massad` | `username`, `password` |
| `union` | `username`, `password` |
| `yahav` | `username`, `password`, `nationalId` |
| `visaCal` | `username`, `password` |
| `max` | `username`, `password` |
| `isracard` | `id`, `card6Digits`, `password` |
| `amex` | `username`, `card6Digits`, `password` |
| `oneZero` | `email`, `password` |

---

## Rotating a credential

```bash
printf '%s' "new-password" > secrets/leumi_password && chmod 400 secrets/leumi_password
docker compose restart
```
