# Deploying UMSHA Ledger

Everything runs on the company Google account at zero cost: a Google Sheet (the database), an Apps Script web app (the API) and GitHub Pages (the app). Do these steps **signed in as the company account**, not a personal one. That account owns the data.

You need Node 20+ on your computer. Nothing else is installed into the project; `clasp` (Google's Apps Script command-line tool) is run with `npx`.

## 1. Create the Sheet

1. In Google Drive (company account), create a blank Google Sheet named **UMSHA Ledger**.
2. Copy its ID from the URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.
3. Do **not** share the Sheet with anyone. People reach the data only through the app, which checks who they are and what their role allows.

Optional: create two Drive folders, **UMSHA Ledger backups** and **UMSHA Ledger attachments**, and note their IDs (from the folder URL). You will put them in Settings after setup.

## 2. Create the Google sign-in client

1. Go to <https://console.cloud.google.com/> → create a project (e.g. `umsha-ledger`).
2. **APIs & Services → OAuth consent screen**: User type *External*, app name *UMSHA Ledger*, support email = company account. Add the scopes `email`, `profile`, `openid`. Publishing needs a home page and privacy policy on the Branding page; the simple route is to leave it in *Testing* and add every staff member as a test user (up to 100).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**: type *Web application*.
   - Authorized JavaScript origins: your GitHub Pages origin, e.g. `https://sumar-razvi.github.io`, plus `http://localhost:8000` and `http://localhost` for testing.
4. Copy the **Client ID** (`….apps.googleusercontent.com`). It is not a secret, but keep it in Script Properties and the app's CONFIG block, not scattered in code.

## 3. Create and push the Apps Script project

```bash
npx @google/clasp login                     # opens a browser: sign in as the company account
npx @google/clasp create --type standalone --title "UMSHA Ledger API" --rootDir apps-script
npm run build                               # regenerates apps-script/Core.gs and Seed.gs from /core and /seed
npx @google/clasp push
```

`clasp create` writes `.clasp.json` (git-ignored; see `.clasp.json.example`). Enable the Apps Script API first if clasp asks: <https://script.google.com/home/usersettings>.

Things that commonly go wrong here:
- Run every command from the project folder (the one with `package.json`), or clasp saves `.clasp.json` somewhere else and `push` says *Project settings not found*.
- `clasp create` may replace `apps-script/appsscript.json` with a blank manifest. Restore ours before pushing: `git checkout -- apps-script/appsscript.json`. When `push` asks whether to overwrite the manifest, answer yes.
- *No credentials found*: `clasp login` did not finish. If login fails with `request to https://oauth2.googleapis.com/token failed` or `ETIMEDOUT`, the network is blocking Node (not the browser): try another network (a phone hotspot works), or set `$env:NODE_OPTIONS="--dns-result-order=ipv4first"` in PowerShell.
- Windows PowerShell *running scripts is disabled*: use `npx.cmd` / `npm.cmd`.

Always run `npm run build` (and `npm test`) before `clasp push`, so the server runs exactly the code the tests checked.

## 4. Script Properties

Open the project at <https://script.google.com> (company account) → **Project Settings** (gear icon). Check that the time zone is *(GMT+05:00) Karachi* (it comes from our manifest). Under **Script Properties**, add:

| Property | Value |
|---|---|
| `SHEET_ID` | the Sheet ID from step 1 |
| `OAUTH_CLIENT_ID` | the Client ID from step 2 |

## 5. Run Setup and schedule backups

In the editor, choose the function **`setupRun`** and press **Run**. Approve the permissions (Sheets, Drive for backups, external requests for sign-in checks, triggers). Setup:

- creates every tab with its header row and plain-text formatting on text columns,
- loads the chart of accounts, tax codes, settings and default dashboard targets (`KpiTargets`) from `/seed`,
- adds the company account as the first **Owner**.

Running it again is safe: it only adds what is missing.

Then run **`installTriggers`** once. It schedules `nightly` at 02:00 Karachi time. That job:
- copies the Sheet to the backup folder and keeps 30 copies;
- prunes the idempotency log;
- checks the stock cache against the stock moves, recording any difference in AuditLog;
- rebuilds the dashboard summaries (`MonthlySummary`, `DailySales`) from the ledger and logs any drift from the live updates.

## 6. Deploy the web app

```bash
npx @google/clasp deploy --description "v1"
```

Or in the editor: **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone** (the manifest already says this). "Anyone" is required because the browser calls the API directly. Security does not depend on the URL being secret: every request carries a Google ID token, which the server verifies, and then it checks the user's role.

Copy the web app URL (`https://script.google.com/macros/s/…/exec`) and check it:

```bash
curl -L "https://script.google.com/macros/s/…/exec"
# {"ok":true,"data":{"service":"umsha-ledger","status":"ok"}}
```

Put the URL and the Client ID into the `CONFIG` block at the top of `index.html`.

## 6b. Publish the app on GitHub Pages

The app is `index.html` plus `core.bundle.js`, served as they are from the repo (the empty `.nojekyll` file tells GitHub not to process them). GitHub Pages is free for public repositories; a private repository needs a paid GitHub plan. The repository holds no secrets: the API URL and Client ID are public by design, and the data lives only in the Sheet.

1. Commit the `CONFIG` change and merge it into `main`.
2. On GitHub: the repository → **Settings → Pages** → **Source: Deploy from a branch**, branch `main`, folder `/ (root)` → **Save**.
3. After a minute or two the app is at `https://<github-user>.github.io/<repo>/` (for this repo, `https://sumar-razvi.github.io/Umsha-Ledger/`). Its origin (`https://sumar-razvi.github.io`, no path) must be in the OAuth client's **Authorized JavaScript origins** (step 2).

Every later push to `main` republishes the page.

### Updating later

```bash
npm test && npm run build && npx @google/clasp push
npx @google/clasp deployments                       # find the deployment ID
npx @google/clasp deploy -i <deploymentId> --description "what changed"
```

Re-deploying to the **same deployment ID** keeps the URL unchanged. If a release adds columns or tabs, run `setupRun` again (or Settings → Run setup in the app). The first run after upgrading to the dashboard release also fills `MonthlySummary` and `DailySales` from the existing entries.

## 7. Users and settings

Add staff as users (Owner only) in the app: **Settings → People → Add person**, each with one role: Owner, Finance, Studio, Store (with their store code, e.g. `MIRAE-KHI-01`) or Viewer. While the OAuth consent screen is in *Testing*, also add each person's Gmail as a **test user** in Google Cloud (Google Auth Platform → Audience), or Google will refuse their sign-in.

In **Settings**, fill in company name, NTN/STRN, `backupFolderId` and `attachmentsFolderId`.

## Checking speed

`npm run perf` builds about 20,000 journal lines (a busy year) through the real server code in memory and lists, for every screen and report, the server time and the number of Sheet cells read, with an estimate for Apps Script (targets: screens under 3 s, reports under 8 s). To confirm on Google, copy the production Sheet, point a test deployment's `SHEET_ID` at the copy and time the same screens; the response `meta.ms` field gives the server time.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `The SHEET_ID script property is not set` | Step 4 |
| `The … tab is missing. The Owner needs to run Setup.` | Run `setupRun` |
| `Your sign-in could not be verified` | `OAUTH_CLIENT_ID` must equal the Client ID in `index.html`; the app's origin must be in the OAuth client's JavaScript origins |
| `The account … does not have access` | Add the email to Users (lower case, `isActive` TRUE) |
| `The system is busy …` | Another save held the lock for 20 s; the app retries automatically with the same request ID |
| Dashboard numbers look stale or wrong | Settings → System → Rebuild dashboard summaries (Owner); the audit log shows any drift found |
| Errors after editing code | `npm test`, `npm run build`, `clasp push`, then redeploy to the same deployment ID |
