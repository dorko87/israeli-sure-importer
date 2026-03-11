# Israeli Banks → Sure Finance Importer

Scrapes Israeli bank and credit card accounts using [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers) (headless Chromium) and imports the transactions into a self-hosted [Sure Finance](https://github.com/we-promise/sure) instance via its REST API.

Runs as a hardened Docker container on your Unraid homelab.

---

## Supported Banks

| Company ID | Bank / Card |
|------------|-------------|
| `hapoalim` | Bank Hapoalim |
| `leumi` | Bank Leumi |
| `mizrahi` | Mizrahi-Tefahot |
| `discount` | Bank Discount |
| `mercantile` | Mercantile Discount |
| `otsarHahayal` | Bank Otsar Ha-Hayal |
| `max` | Max (formerly Leumi Card) |
| `visaCal` | Visa Cal |
| `isracard` | Isracard |
| `amex` | American Express Israel |
| `union` | Union Bank |
| `beinleumi` | Bank Beinleumi (FIBI) |
| `massad` | Bank Massad |
| `yahav` | Bank Yahav |
| `beyahadBishvilha` | Beya Had Bishvilha |
| `oneZero` | One Zero |
| `behatsdaa` | Behatsdaa |
| `pagi` | Pagi |

---

## Quick Start

### 1. Prerequisites

- Docker + Docker Compose
- A running [Sure Finance](https://github.com/we-promise/sure) instance
- A Sure API key (Settings → API Keys)

### 2. Initial Setup

```bash
# Clone / copy this directory to your server
cd israeli-sure-importer

# Run the interactive setup wizard
bash setup.sh
```

The wizard will:
- Prompt for your Sure URL and API key (saved to `secrets/sure_api_key`)
- Prompt for each bank's credentials (saved to `secrets/`)
- Ask for the Sure account UUIDs to import into
- Write `config.json` for you

### 3. Find your Sure Account UUIDs

In your Sure Finance browser: navigate to the account, copy the UUID from the URL:
```
https://your-sure/accounts/00000000-0000-0000-0000-000000000001
                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

### 4. Test

```bash
docker compose run --rm israeli-sure-importer
```

### 5. Start scheduled

```bash
docker compose up -d
docker compose logs -f
```

---

## Configuration

### config.json structure

`config.json` contains **no credentials** — only filenames that point to secret files.

```json
{
  "sure": {
    "baseUrl": "http://sure:3000",
    "apiKeyFile": "sure_api_key"
  },
  "banks": {
    "hapoalim": {
      "credentialKeys": {
        "userCode": "hapoalim_user_code",
        "password": "hapoalim_password"
      },
      "targets": [
        {
          "sureAccountId": "<uuid-from-sure-url>",
          "sureAccountName": "Hapoalim Main",
          "accounts": "all",
          "includePending": false
        }
      ]
    }
  }
}
```

See `config.example.json` for all supported banks.

### Schedule

Edit the `SCHEDULE` environment variable in `compose.yml`:

```yaml
SCHEDULE: "0 8 * * *"   # daily at 08:00 Israel time
```

Remove `SCHEDULE` entirely to run once and exit (useful for testing).

### Sync state

The importer stores the last successful sync timestamp per bank in `/app/cache/sync-state.json` (a tmpfs mount — reset on container restart). On first run it fetches the last 90 days.

---

## Security

- Credentials are stored as individual files in `secrets/` (gitignored, chmod 400)
- No credentials are ever written to logs, environment variables, or config.json
- The container runs as a non-root user with a read-only filesystem
- No inbound ports are exposed
- All URLs are validated (UUID check on account IDs prevents SSRF)

---

## Debugging

```bash
# Run with debug logging
docker compose run --rm -e LOG_LEVEL=debug israeli-sure-importer

# Show the browser window (requires display server)
docker compose run --rm -e SHOW_BROWSER=true israeli-sure-importer
```

## Local development (without Docker)

```bash
npm install
export SECRETS_DIR=./secrets
export CONFIG_PATH=./config.json
export LOG_LEVEL=debug
npx ts-node src/index.ts
```

---

## Connect to Sure's Docker network

If Sure runs in a separate Compose stack:

```bash
docker network ls | grep sure
```

Then update `compose.yml`:

```yaml
networks:
  sure-internal:
    external: true
    name: <actual-sure-network-name>
```

---

## Adding a new bank

1. Find the `companyId` in [israeli-bank-scrapers docs](https://github.com/eshaham/israeli-bank-scrapers)
2. Add an entry to `config.example.json` under `banks`
3. Add the credential files to `secrets/README.md`
4. Add to the supported banks table above
5. Add to `setup.sh`'s bank selection section

No changes needed to `scraper.ts` — it reads `CompanyTypes` dynamically.
