# Test Planner — Cross-File Contract

This file is the single source of truth for column names, payload shapes,
and cron config used by the test-planner feature. Do not change any name
here without updating every consumer (calculator UI in `dashboard.html`,
cron worker in `api/test-monitor.js`, email handler in `api/send-email.js`,
and email renderers in `api/lib/email-templates.js`).

## Database — `tests` table additions

| Column | Type | Filled by | Notes |
|---|---|---|---|
| `started_at` | TIMESTAMPTZ | `toggleTestStatus()` on activate | NULL when test is in `draft` |
| `target_sample_size` | INT | `createTest()` from calculator | per variant, not total |
| `baseline_cvr` | NUMERIC(5,4) | `createTest()` from calculator | fraction; 0.0300 = 3% |
| `mde` | NUMERIC(5,4) | `createTest()` from calculator | relative lift fraction; 0.2000 = +20% |
| `expected_cpc` | NUMERIC(8,2) | `createTest()` from calculator | currency ₪ |
| `kickoff_sent_at` | TIMESTAMPTZ | `toggleTestStatus()` after Brevo 200 | dedupe lock |
| `last_milestone_sent` | INT (default 0) | cron worker | one of {0, 25, 50, 75, 100} |
| `stall_alert_sent_at` | TIMESTAMPTZ | cron worker | dedupe lock |
| `summary_sent_at` | TIMESTAMPTZ | cron worker | dedupe lock; can fire pre-100% if WINNER_FOUND |
| `summary_verdict` | TEXT (CHECK) | cron worker | `WINNER_FOUND` / `PRACTICAL_TIE` / `TRENDING_UNDERPOWERED` |
| `summary_winner_variant_id` | UUID FK→project_variants | cron worker | NULL for PRACTICAL_TIE |
| `summary_lift_pct` | NUMERIC(8,2) | cron worker | NULL for PRACTICAL_TIE |
| `economic_verdict` | TEXT (CHECK) | cron worker (markEmailSent) | one of `VIABLE` / `NOT_VIABLE` / `WINNER_BUT_CHEAPER_ELSEWHERE` / `INSUFFICIENT_SPEND` / `INSUFFICIENT_DATA` |
| `cpl_leader_variant_id` | UUID FK→project_variants | cron worker | NULL except for `WINNER_BUT_CHEAPER_ELSEWHERE` |
| `oldest_spend_age_days` | INT | cron worker | snapshot of staleness at email-send time |

## Database — `projects` table additions (CPL feature)

| Column | Type | Filled by | Notes |
|---|---|---|---|
| `target_cpl` | NUMERIC(8,2) | project create/edit form | Optional. NULL means CPL feature OFF for that project |

## Database — `test_variants` table additions (CPL feature)

| Column | Type | Filled by | Notes |
|---|---|---|---|
| `spend` | NUMERIC(10,2) | dashboard inline edit | Cumulative manually-entered spend |
| `spend_updated_at` | TIMESTAMPTZ | dashboard inline edit | NULL until first entry |

## `/api/send-email` — new action discriminators

All actions POST as JSON, identical to existing `meta_capi` pattern:

```json
{ "action": "test_kickoff",       "test_id": "<uuid>" }
{ "action": "test_milestone",     "test_id": "<uuid>", "milestone": 25 }
{ "action": "test_summary",       "test_id": "<uuid>", "verdict": "WINNER_FOUND" }
{ "action": "test_stall_alert",   "test_id": "<uuid>" }
```

`verdict` is one of: `WINNER_FOUND`, `PRACTICAL_TIE`, `TRENDING_UNDERPOWERED`.

The handler fetches the `tests` row + `test_variants` + variant counts itself
(handler is the source of truth on rendering data; cron does not pass them).

## Cron config (`vercel.json`)

```json
"crons": [
  { "path": "/api/test-monitor", "schedule": "0 6 * * *" }
]
```

Runs daily at 06:00 UTC (08:00 IL winter / 09:00 IL summer; DST drift accepted).
Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` header. The
worker must verify this header against `process.env.CRON_SECRET` and 401 if
mismatched.

## Cron worker SELECT query

```sql
-- 1. Get all running tests
SELECT id, name, slug, community_id, started_at, target_sample_size,
       baseline_cvr, mde, expected_cpc, last_milestone_sent,
       stall_alert_sent_at, summary_sent_at
FROM tests WHERE status='running';

-- 2. For each test, get per-variant unique-visitor + lead counts
SELECT
  variant_id,
  COUNT(DISTINCT (event_data->>'visitor_id')) AS unique_visitors,
  COUNT(*) FILTER (WHERE event_type='lead_captured') AS conversions
FROM analytics_events
WHERE test_id=$1 AND event_type IN ('pageview','lead_captured')
GROUP BY variant_id;
```

(In code, use PostgREST query builder via the Supabase JS client; pagination
follows the pattern already in `dashboard.html` near line 1885.)

## Required environment variables

- `CRON_SECRET` — random hex string, set in Vercel dashboard. Used to
  authenticate the daily cron POST to `/api/test-monitor`.
- All existing vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `BREVO_API_KEY`, `SENDER_EMAIL`, `APP_URL`) — already configured.
