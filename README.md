# CheckFire Recycling Returns System

One small app, three screens, no manual re-keying:

| Screen | Who uses it | URL |
|---|---|---|
| **Dashboard** | Office / CX | `http://<server>:8080/` |
| **Counter form** | Rec team (tablet or PC on the floor) | `http://<server>:8080/count` |
| **WTN** | Generated per completed order | `http://<server>:8080/wtn/<id>` |

## How the flow works

1. **SO raised in NetSuite** with the crate item → appears on the "Just Crate SO's" web query (report79).
2. **The server pulls the web query automatically** (every 15 minutes, configurable) — Document Number gets the **C suffix** (SO824039 → SO824039C), along with Date Created, Created By, Company Name and Quantity Billed (= crates, capped at 10). No keying. There's a CSV upload on the dashboard as a fallback if the web query is ever unreachable.
3. **Rec team counts each crate** on the counter form — pick the collection, enter counts in a grid that mirrors the paper Recycling Collection Form (Water / Foam / Powder / CO2 Steel / Aluminium / Other), name, save. Counts route straight into the dashboard.
4. **Dashboard shows what's outstanding** — "2 of 3 crates" with progress bars and a running product total per SO. Partial counts accumulate.
5. **Final crate counted → order auto-moves to Completed**, a sequential WTN reference is assigned (WTN-YYYY-NNNN), and the Duty of Care WTN is available to print/send — same format as the existing customer-facing template (EWC 16 05 05, CBDU1833, Sections A–E, Section E totals filled from the counts).
5a. **If the counter form can't find the SO** (not synced yet, or genuinely not raised for this delivery), the Rec team can tap *Count anyway — no SO yet* on the counter form: they enter the customer name and how many cages/pallet boxes are in the delivery, and counting proceeds against a placeholder order (`MANUAL-<id>`, tagged `source: "manual"`) instead of falling back to paper. It shows on the dashboard with a **No SO yet** badge and an inline field — type the real SO number in once it's raised in NetSuite and it replaces the placeholder (matched by `so` from then on, so a later NetSuite sync will keep it updated same as any other order).
6. **SO against the count**: the completed card shows the rolled-up NetSuite scrapping-charge lines (SC-WAT-000, SC-FOA-006, SC-POW-000…). Until the API lands, raise the SO in NetSuite from those lines and type its number into the card. Phase 3 automates this — the hook is already in `server.js` (`createNetSuiteSalesOrder`).

## Running it

Needs only [Node.js](https://nodejs.org) (LTS). No other installs.

```
cd recycling-app
node server.js
```

Then open `http://localhost:8080/`. For team use, run it on any always-on PC/server on the office network and share the address (e.g. `http://192.168.1.50:8080/count` for the Rec team). Ask IT to register it as a service/scheduled task so it starts with the machine.

**Data** lives in `data.json` next to the server — back that file up. **Settings** live in `config.json`:

- `netsuite.webQueryUrl` / `email` — the report79 web query. The `[EMAIL]` token is replaced with the email value.
- `netsuite.autoSyncMinutes` — polling interval (0 = manual sync only).
- `products` — the count grid, NetSuite item codes and WTN box mapping, all in one place.
- `wtn` — EWC code, carrier registration, reference prefix.
- `maxCrates` — currently 60 (raised from 10 so a full Chubb delivery — 45-53 cages or 28 pallet boxes — fits in one order; NetSuite's Quantity Billed is capped at this on sync, and it's also the ceiling the counter form offers per screen).

## Notes & known points

- If NetSuite rejects the unattended web query call (it can be fussy about session auth), the dashboard's **Sync** button will say so — use the **CSV fallback** (open report79.iqy in Excel, save as CSV, upload) until Phase 3 replaces the web query with a proper API feed.
- Both 2KG Alu Squat and Tall currently map to `SC-COO-002-ALU` — edit `config.json` if Tall should map to `D/S cylinder 2KG Tall`.
- The WTN's "Name of Contact" and D1 collection address aren't on the web query, so they stay blank for handwriting — they can be added to the saved search later and prefilled.

## Hosting it live — free (Render + GitHub data store)

The app runs on Render's **free plan**; count data persists by being committed to a **private GitHub data repo** (the free plan's own disk is wiped on every restart). The data repo also gives you a complete change history of every count.

One-time setup:

1. **Create the data repo**: on GitHub, New repository → name `recycling-returns-data` → **Private** → create. Leave it empty.
2. **Create a token**: GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: *Only select repositories* → `recycling-returns-data`. Permissions: *Contents → Read and write*. Set a long expiry. Copy the token.
3. **Deploy**: render.com → sign in with GitHub → New + → Blueprint → pick `recycling-returns-counts`. Fill the env vars:
   - `NETSUITE_WEBQUERY_URL` — the report79 web query URL (keep the `[EMAIL]` token in it)
   - `NETSUITE_EMAIL` — your NetSuite login email
   - `GH_DATA_REPO` — `<your-username>/recycling-returns-data`
   - `GH_TOKEN` — the token from step 2
   - `ACCESS_KEY` — leave empty for open access, or set a passphrase
4. Your URLs: `https://<service>.onrender.com/` (dashboard) and `.../count` (counter app — bookmark this on the Rec team devices).

Every `git push` to main redeploys automatically.

**Free plan quirk**: after 15 minutes with no visitors the service goes to sleep and the next visit takes ~1 minute to wake — the page will sit loading, then appear. If that annoys the Rec team, a free uptime pinger (e.g. cron-job.org hitting the dashboard URL every 10 minutes during work hours) keeps it awake.

## Phase 3 — NetSuite API

When ready: create an Integration record in NetSuite (Setup → Integration), generate TBA tokens, then implement `createNetSuiteSalesOrder()` in `server.js` (SuiteTalk REST, `POST /record/v1/salesOrder`, lines from the rolled-up codes) and set `netsuite.api.enabled` to `true` in `config.json`. The function is called automatically the moment the final crate is counted.
