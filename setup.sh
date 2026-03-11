#!/usr/bin/env bash
# setup.sh — Interactive wizard to create the secrets/ directory and config.json
# Requires only bash — no python3, jq, or other external tools.
# Run once on initial setup: bash setup.sh
set -euo pipefail

# Strip Windows \r line endings from this script itself before anything else runs.
# This handles the case where the file was written through a Samba/Windows share.
if grep -qP '\r' "$0" 2>/dev/null; then
  sed -i 's/\r//' "$0"
  exec bash "$0" "$@"
fi

SECRETS_DIR="./secrets"
CONFIG_FILE="./config.json"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
# Always write to stderr so info/warn are never captured by $() subshells
info() { echo -e "${GREEN}[INFO]${NC}  $*" >&2; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*" >&2; }

# ---------------------------------------------------------------------------
# JSON string escaping — no external tools required
# ---------------------------------------------------------------------------
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"    # backslash  ->  \\
  s="${s//\"/\\\"}"    # "          ->  \"
  s="${s//$'\n'/\\n}"  # newline    ->  \n
  s="${s//$'\r'/\\r}"  # CR         ->  \r
  s="${s//$'\t'/\\t}"  # tab        ->  \t
  s="${s//$/\$}"       # dollar     ->  \$ (prevents printf expansion)
  printf '%s' "$s"
}

# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------
read_secret() {
  local prompt="$1"
  local varname="$2"
  local value=""
  while [[ -z "$value" ]]; do
    # -s suppresses echo; IFS= preserves leading/trailing whitespace
    IFS= read -rsp "  $prompt: " value
    echo ""
    # Strip \r in case of Windows CRLF from SSH terminal or script file
    value="${value//$'\r'/}"
    if [[ -z "$value" ]]; then
      warn "Value cannot be empty. Please try again."
    fi
  done
  printf '%s' "$value" > "${SECRETS_DIR}/${varname}"
  chmod 400 "${SECRETS_DIR}/${varname}"
  # Ensure UID 1000 (container's node user) can read the file
  chown 1000:1000 "${SECRETS_DIR}/${varname}" 2>/dev/null || true
  info "Saved secrets/${varname}"
}

# read_value is for NON-SENSITIVE input only (URLs, labels, UUIDs).
# Never use it for passwords or API keys.
read_value() {
  local prompt="$1"
  local value=""
  while [[ -z "$value" ]]; do
    read -rp "  $prompt: " value
    # Strip \r in case of Windows CRLF from SSH terminal or script file
    value="${value//$'\r'/}"
    if [[ -z "$value" ]]; then
      warn "Value cannot be empty. Please try again."
    fi
  done
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# JSON bank entry builder — appends to the global $bank_entries string
# ---------------------------------------------------------------------------
bank_entries=""

add_bank_entry() {
  local bank_key="$1"
  local cred_keys_json="$2"
  local uuid="$3"
  local label="$4"
  local extra_target="$5"

  local escaped_label escaped_uuid
  escaped_label=$(json_escape "$label")
  escaped_uuid=$(json_escape "$uuid")

  local target_json="{\"sureAccountId\":\"${escaped_uuid}\",\"sureAccountName\":\"${escaped_label}\""
  if [[ -n "$extra_target" ]]; then
    target_json="${target_json},${extra_target}"
  fi
  target_json="${target_json}}"

  local entry="\"${bank_key}\":{\"credentialKeys\":${cred_keys_json},\"targets\":[${target_json}]}"

  if [[ -n "$bank_entries" ]]; then
    bank_entries="${bank_entries},${entry}"
  else
    bank_entries="${entry}"
  fi
}

# ---------------------------------------------------------------------------
# Setup Sure connection
# ---------------------------------------------------------------------------
setup_sure() {
  echo "" >&2
  echo "=== Sure Finance Connection ===" >&2
  local baseUrl
  baseUrl=$(read_value "Sure base URL (e.g. http://192.168.1.100:3011)")
  read_secret "Sure API key (from Sure Settings -> API Keys)" "sure_api_key"
  printf '%s' "$baseUrl"
}

# ---------------------------------------------------------------------------
# Bank credential helpers
# ---------------------------------------------------------------------------
setup_bank_hapoalim()  { read_secret "Hapoalim user code" "hapoalim_user_code"; read_secret "Hapoalim password" "hapoalim_password"; }
setup_bank_leumi()     { read_secret "Leumi username" "leumi_username"; read_secret "Leumi password" "leumi_password"; }
setup_bank_mizrahi()   { read_secret "Mizrahi username" "mizrahi_username"; read_secret "Mizrahi password" "mizrahi_password"; }
setup_bank_discount()  { read_secret "Discount ID (teudat zehut)" "discount_id"; read_secret "Discount password" "discount_password"; read_secret "Discount account number" "discount_num"; }
setup_bank_max()       { read_secret "Max username (email)" "max_username"; read_secret "Max password" "max_password"; }
setup_bank_visacal()   { read_secret "Visa Cal username" "visacal_username"; read_secret "Visa Cal password" "visacal_password"; }
setup_bank_isracard()  { read_secret "Isracard ID (teudat zehut)" "isracard_id"; read_secret "Isracard card last 6 digits" "isracard_card6digits"; read_secret "Isracard password" "isracard_password"; }
setup_bank_amex()      { read_secret "Amex ID (teudat zehut)" "amex_id"; read_secret "Amex card last 6 digits" "amex_card6digits"; read_secret "Amex password" "amex_password"; }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo ""
  echo "======================================================"
  echo "  Israeli Banks -> Sure Finance -- Setup Wizard"
  echo "======================================================"
  echo ""

  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  info "Created $SECRETS_DIR/"

  local sureUrl ans uuid label
  sureUrl=$(setup_sure)

  echo ""
  echo "=== Bank Accounts ==="
  echo "Select which banks to configure (enter y/n):"
  echo ""

  read -rp "  Bank Hapoalim? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Bank Hapoalim..."
    setup_bank_hapoalim
    uuid=$(read_value "Hapoalim target Sure account UUID (from Sure URL)")
    label=$(read_value "Label for this account (for logs)")
    add_bank_entry "hapoalim" \
      '{"userCode":"hapoalim_user_code","password":"hapoalim_password"}' \
      "$uuid" "$label" '"accounts":"all","includePending":false'
  fi

  read -rp "  Bank Leumi? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Bank Leumi..."
    setup_bank_leumi
    uuid=$(read_value "Leumi target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "leumi" \
      '{"username":"leumi_username","password":"leumi_password"}' \
      "$uuid" "$label" '"accounts":"all"'
  fi

  read -rp "  Bank Mizrahi? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Bank Mizrahi..."
    setup_bank_mizrahi
    uuid=$(read_value "Mizrahi target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "mizrahi" \
      '{"username":"mizrahi_username","password":"mizrahi_password"}' \
      "$uuid" "$label" '"accounts":"all"'
  fi

  read -rp "  Bank Discount? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Bank Discount..."
    setup_bank_discount
    uuid=$(read_value "Discount target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "discount" \
      '{"id":"discount_id","password":"discount_password","num":"discount_num"}' \
      "$uuid" "$label" '"accounts":"all"'
  fi

  read -rp "  Max credit card? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Max..."
    setup_bank_max
    uuid=$(read_value "Max target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "max" \
      '{"username":"max_username","password":"max_password"}' \
      "$uuid" "$label" '"accounts":"all","includePending":true'
  fi

  read -rp "  Visa Cal? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Visa Cal..."
    setup_bank_visacal
    uuid=$(read_value "Visa Cal target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "visaCal" \
      '{"username":"visacal_username","password":"visacal_password"}' \
      "$uuid" "$label" '"accounts":"all"'
  fi

  read -rp "  Isracard? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up Isracard..."
    setup_bank_isracard
    uuid=$(read_value "Isracard target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "isracard" \
      '{"id":"isracard_id","card6Digits":"isracard_card6digits","password":"isracard_password"}' \
      "$uuid" "$label" '"accounts":"all"'
  fi

  read -rp "  American Express? [y/N] " ans
  if [[ "${ans,,}" == "y" ]]; then
    echo ""; info "Setting up American Express..."
    setup_bank_amex
    uuid=$(read_value "Amex target Sure account UUID")
    label=$(read_value "Label for this account")
    add_bank_entry "amex" \
      '{"id":"amex_id","card6Digits":"amex_card6digits","password":"amex_password"}' \
      "$uuid" "$label" '"accounts":"all"'
  fi

  # Write config.json — pass all values via printf %s (no heredoc variable expansion)
  local escaped_url
  escaped_url=$(json_escape "$sureUrl")

  printf '{\n  "sure": {\n    "baseUrl": "%s",\n    "apiKeyFile": "sure_api_key"\n  },\n  "banks": {\n    %s\n  }\n}\n' \
    "$escaped_url" "$bank_entries" > "$CONFIG_FILE"

  info "Written $CONFIG_FILE"

  echo ""
  echo "======================================================"
  info "Setup complete!"
  echo ""
  echo "  Verify:      cat config.json"
  echo "  Test run:    docker compose run --rm israeli-sure-importer"
  echo "  Start:       docker compose up -d"
  echo "  Logs:        docker compose logs -f"
  echo "======================================================"
}

main "$@"
