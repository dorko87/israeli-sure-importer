#!/usr/bin/env bash
# setup.sh — interactive wizard to create secrets/ for israeli-banks-sure-importer
# Run this once before starting the container for the first time.
#
# Each secret is written as a plain file (raw value, no quotes, no newline)
# with chmod 400 so only the owner can read it.
#
# Usage:
#   bash setup.sh

set -euo pipefail

SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secrets"
mkdir -p "$SECRETS_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────

write_secret() {
  local name="$1"
  local value="$2"
  local path="$SECRETS_DIR/$name"
  printf '%s' "$value" > "$path"
  chmod 400 "$path"
  echo "  ✓ Written: secrets/$name"
}

prompt_secret() {
  local prompt="$1"
  local value
  printf '%s' "$prompt"
  read -r -s value
  echo
  echo "$value"
}

prompt_value() {
  local prompt="$1"
  local value
  printf '%s' "$prompt"
  read -r value
  echo "$value"
}

section() {
  echo
  echo "────────────────────────────────────────"
  echo "  $1"
  echo "────────────────────────────────────────"
}

# ── Sure Finance API key ─────────────────────────────────────────────────────

section "Sure Finance API key"
echo "Find this in Sure → Settings → API Keys."
echo
SURE_API_KEY=$(prompt_secret "Sure API key: ")
write_secret "sure_api_key" "$SURE_API_KEY"

# ── Telegram bot token (optional) ────────────────────────────────────────────

section "Telegram (optional)"
echo "Leave blank to skip Telegram alerts."
echo
TELEGRAM_TOKEN=$(prompt_secret "Telegram bot token (blank to skip): ")
if [[ -n "$TELEGRAM_TOKEN" ]]; then
  write_secret "telegram_bot_token" "$TELEGRAM_TOKEN"
  echo
  echo "  ⚠  Remember to set TELEGRAM_CHAT_ID in compose.yml."
else
  echo "  Skipped."
fi

# ── Bank credentials ─────────────────────────────────────────────────────────

section "Bank / card credentials"
echo "You will be asked which banks to add."
echo "Add as many as you need; press Enter with no input to finish."
echo
echo "Supported companyId values:"
echo "  hapoalim  leumi  discount  mercantile  mizrahi  otsarHahayal"
echo "  beinleumi massad union yahav visacal max isracard amex oneZero"
echo

while true; do
  COMPANY=$(prompt_value "companyId (blank to finish): ")
  [[ -z "$COMPANY" ]] && break

  echo
  echo "Credential fields vary by bank. Common fields:"
  echo "  username / password / userCode / id / card6Digits / nationalId / num"
  echo "See CLAUDE.md or README.md for the exact fields required by $COMPANY."
  echo

  while true; do
    FIELD=$(prompt_value "  Credential field name (blank to finish $COMPANY): ")
    [[ -z "$FIELD" ]] && break

    VALUE=$(prompt_secret "  Value for $FIELD: ")
    FILENAME="${COMPANY}_${FIELD}"
    write_secret "$FILENAME" "$VALUE"
  done

  echo
  echo "  Done with $COMPANY."
  echo "  Add this to config.json under credentialSecrets:"
  echo "    \"credentialSecrets\": { \"$FIELD\": \"${COMPANY}_${FIELD}\", ... }"
  echo
done

# ── Done ─────────────────────────────────────────────────────────────────────

section "Setup complete"
echo "Secret files created in: $SECRETS_DIR"
echo
echo "Next steps:"
echo "  1. Copy config.example.json → config.json and edit it."
echo "  2. Set TELEGRAM_CHAT_ID in compose.yml (if using Telegram)."
echo "  3. Create Unraid host directories and set ownership:"
echo "       mkdir -p /mnt/user/appdata/sure/israeli-sure-importer/{cache,browser-data,logs}"
echo "       chown -R 1000:1000 /mnt/user/appdata/sure/israeli-sure-importer/{cache,browser-data,logs}"
echo "  4. Build the image:  docker compose build"
echo "  5. Test run (dry):   docker compose run --rm israeli-sure-importer node dist/index.js --run-once --dry-run"
echo "  6. Test run (real):  docker compose run --rm israeli-sure-importer node dist/index.js --run-once"
echo "     Check Sure → Imports, confirm the data looks correct."
echo "  7. Set PUBLISH: \"true\" in compose.yml, then:  docker compose up -d"
echo
