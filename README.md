# WealthHQ — Personal Family Office OS

One dashboard for every dollar you own and owe. Multi-tenant (household-based),
Netlify + Supabase, no build step, no CLI required.

## What's in the box

| File | Purpose |
|---|---|
| `index.html` | The entire application (SPA, dark glass UI, Chart.js, animated counters) |
| `supabase/schema.sql` | Full relational schema: 21 tables, row-level security, private vault bucket, audit log |
| `netlify/functions/ai-advisor.js` | AI Advisor — proxies your ledger snapshot + question to the Anthropic API |
| `netlify.toml` | Netlify config (functions dir + security headers) |

## Modules

Home (executive summary, daily snapshots, financial score, wealth chart, allocation,
upcoming bills, quick actions) · Net Worth (18 asset categories with cost basis,
appreciation, annualized growth) · Liabilities (rate, payoff forecast via amortization
math) · Real Estate (equity, NOI, cap rate, cash flow) · Vehicles (depreciation) ·
Investments (allocation by class + account, unrealized gains, dividend income) ·
Businesses (seeded with #TEACH, J3 Productions, EdConsult; EBITDA×multiple valuation
and equity roll-up into net worth) · Events (budget vs actual, ROI, attendance,
lessons learned) · Goals (progress bars + linear-trend completion forecast) ·
Insurance · Estate · Transactions · Document Vault (private bucket, signed URLs) ·
Reporting (11 report types, print-to-PDF, CSV/Excel export) · AI Advisor ·
Settings (household, security notes, integration roadmap).

## Deploy (browser-only, ~10 minutes)

1. **Supabase**
   - Create a project (or reuse one).
   - SQL Editor → paste `supabase/schema.sql` → Run. (Idempotent; safe to re-run.)
   - Project Settings → API → copy the **URL** and **anon public key**.
2. **GitHub**
   - New repo → upload these four files/folders via the web UI.
   - Edit `index.html` in the web editor: set `SUPABASE_URL` and `SUPABASE_ANON_KEY`
     at the top of the `<script>` block. Commit.
3. **Netlify**
   - New site from Git → pick the repo. No build command; publish dir `.`
   - Site settings → Environment variables → add `ANTHROPIC_API_KEY` (for the AI Advisor).
   - Deploy.
4. **First run**
   - Open the site → Create account → confirm email → sign in.
   - Your household is created automatically and seeded with the three businesses
     and starter goals. Add your first asset; the daily net-worth snapshot begins
     immediately and the growth chart builds from there.

## How net worth is computed (no double counting)

```
Assets  = cash/investment/other asset rows
        + property values + vehicle values + holdings
        + business equity  →  (EBITDA × multiple + cash − debt) × ownership %
Liabilities = liability rows + property mortgages + vehicle loans
Net worth   = Assets − Liabilities
```
Business debt/cash live inside the equity calculation — don't re-enter them as
personal liabilities/assets. Property mortgages belong on the property record.

## Security model

- **RLS everywhere:** every table is filtered by household membership at the
  database layer; the anon key alone can read nothing.
- **Roles:** owner / admin / advisor / viewer on `household_members`
  (viewers/advisors can read and edit values but only owner/admin can delete).
- **Vault:** private storage bucket, path-scoped to household ID, 5-minute signed URLs.
- **Audit log:** every create/update/delete/upload is recorded in `audit_logs`.
- **MFA:** turn on TOTP in Supabase → Authentication → MFA.
- **Backups:** Supabase daily backups (paid plans) + the in-app CSV export.

## Integrations (honest status)

Plaid, QuickBooks, brokerages, Stripe, Zillow, KBB etc. all require API contracts,
OAuth app approvals, or have no public API — no software can "just connect" to them
without credentials. The Settings → Integrations page documents the path for each.
Everything works manually today; the schema is already shaped to receive synced data
(e.g., `transactions`, `holdings`) when you add credentials later.

## Adding a second household member

Supabase → Table Editor → `household_members` → insert their `user_id`
(from `auth.users` after they sign up) with your `household_id` and a role.
An in-app invite flow is a natural v2 feature.

## Troubleshooting

- **"Setup" screen appears** → the two Supabase constants are still placeholders.
- **AI Advisor errors locally** → the Netlify function only runs on the deployed site.
- **Login works but data is empty after a while** → check Supabase Auth JWT expiry
  is 3600s (same fix as your USP portal).
