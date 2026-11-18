# NDC – Not Booked Investigation (local)

Read-only web UI over the `ndc-core-backend-log` OpenSearch logs. Enter a booking reference and/or agency and a
time range; it finds the sessions (`correlationId`), gives each a verdict on where the booking stopped, and shows
the full timeline with request/response payloads on demand.

## Start / operate

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Sheen\ndc-case-investigator\start.ps1          # asks for the OpenSearch password
powershell -ExecutionPolicy Bypass -File C:\Users\Sheen\ndc-case-investigator\start.ps1 -Azure   # also Azure DevOps (Send to team leader)
```
Secrets are asked for at start (hidden input), kept only in that process's environment, never written to disk or
shell history. The script restarts the server if it crashes. It also asks for the UAT classification DB (see below; `-NoDb` skips it).
Install once: `npm install` (only dependency: `mysql2`). Tests: `npm test` (Node's built-in runner).

Code layout: `server.js` (HTTP routes only) · `lib/core.js` (OpenSearch + git/source helpers) · `lib/cases.js` ·
`lib/exceptions.js` · `lib/failures.js` · `lib/ide.js` · `rules.js` (explanations) · `fixrules.js` / `fixer.js`
(suggested fixes) · `report.js` (PDF) · `azdo.js` (Azure DevOps) · `test/`.

## 🔍 Explain a failed booking (Booking failures → row → Explain)

Side panel with (1) **the problem**: a one-line summary, the message, its explanation (`rules.js`) and FAILURE_MESSAGES
entry, what to do; (2) **what the supplier answered**: the supplier calls of the session in the 30 min before the
failure (same supplier + failed first, search calls last; the top 3 are read), HTTP status, the error / warning
elements pulled out of the response (XML: `<Error>`, `<Message code>`, SOAP `faultstring`…; JSON: `errors[].code/title`…)
each with its meaning, and the full response (RAW / XML / coloured JSON) and request. `lib/failexplain.js`,
`GET /api/failure-explain?cid=&time=&supplier=&reason=`. Read-only.

## CRM (Overview + Tickets)

`http://127.0.0.1:8787/` sidebar → **Overview** (`/crm`) and **Tickets** (`/crm?view=tickets`). One ticket = one failed
booking. Tickets are stored locally in `data/crm.json` (atomic writes, daily backup in `data/backups`, 14 kept;
`CRM_DATA_DIR` changes the folder). Nothing is sent anywhere.

- Create: **＋ Ticket** on a Booking failures row or a case, **＋ Tickets for all N shown** on Booking failures, or
  **Import failures** (time range + filters, Preview first). Re-importing the same failure is skipped (session + ref + reason).
- Tickets list: views (open / overdue / urgent / today), status tabs, search, filters, sort, bulk status/priority,
  server-side pagination. Drawer: status, priority, follow-up date, tags, resolution, notes, full history.
- The sidebar search accepts a ticket id (`T-00012`), booking ref, PNR or correlation id.
- Cases and Booking failures tables are paginated too (page size remembered).

## Classified vs unclassified (UAT `wonderdb.FAILURE_MESSAGES`)

`start.ps1` asks for it at every start, like OpenSearch: host:port, user and hidden password (database `wonderdb`).
Default host `192.168.1.71:3306`; type `-` to skip. After you enter the details it tests the connection
(`tools/test-db.js`: reads FAILURE_MESSAGES, prints row count or the error with a hint) and lets you Retry / Skip /
Continue. Host:port and user are remembered in `data/uat-db.json` after a successful test (never the password). Booking failures are
then matched the way `FlightWSService.replaceSupplierErrorToFriendlyError` does: same supplier, `ERROR_MESSAGE`
case-insensitive (the friendly message is matched too). A match from another supplier is marked `*`. With the DB
connected, the DB decides: a failure not in FAILURE_MESSAGES goes to **Other / unclassified** in every view (tiles,
chart, By reason, table, CSV/PDF), with the `rules.js` reason kept as a "Rule hint"; a DB match is never unclassified.

**Handled by backend code = classified too.** A failure not in FAILURE_MESSAGES whose message is produced by odeysys
itself (a literal in a constant, enum, `throw`, `setErrorMessage` or log in the `*.java` files of `GIT_REF`,
e.g. "Your booking is being processed", duplicate booking, wallet balance) is classified with a
**Backend code · File.java:line** badge (click opens IntelliJ). Lookup: `lib/backend.js` (`git grep` on the longest
fixed piece of the message; lines that only compare with the text, `.contains("…")` / `.equals("…")`, don't count;
`odeysysrest-tt` and properties files are never searched). The Classified tile shows "x in DB · y by backend code". Tiles show
Classified / Unclassified (click to filter); the **Not in FAILURE_MESSAGES** table lists the gaps with a draft migration
SQL to copy (review it, then add it as a Flyway migration in odeysys). The list is reloaded every 15 min
(`POST /api/classify/reload` forces it). Without the DB the page says the DB is not connected and works as before.

## What changed (Exceptions page → What changed)

Pick a time (or a recent master/UAT merge from git) and see which error signatures (method + exception) are **new**,
**increased** (≥2×), **gone** or **decreased** since then, with the code location of new ones. Baseline: the same clock
hours on the 3 previous days (average), because traffic has a strong daily cycle; spans over 24h compare with the same
length of time just before. Merge times are git times, not deploy times.

## Send to team leader (Azure DevOps)

Cases page and Booking failures page → **💬 Send to team leader**: posts a comment on an Azure DevOps work item that
@mentions the team leader, with the PDF report attached (uploaded as a work-item attachment). The dialog shows the work
item title before sending; nothing is sent until you click Send. Needs `AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT`
(PAT scopes: Work Items Read & Write, Identity Read) – `start.ps1 -Azure` asks for them.

## Per-booking verdict

On the Cases page each ref's verdict and supplier come from its own pay & book window (a session can contain several
bookings). When the whole session's verdict differs, it is shown underneath as "Whole session: …".
The Booking failures page lists **Unclassified messages** (no rule yet) – add rules for frequent ones in `rules.js`.

## Run

Node 18+ (`npm install` once for `mysql2`). Credentials come only from environment variables.

PowerShell:
```powershell
$env:OSD_USER = "ndc-core-user"
$env:OSD_PASS = Read-Host "OpenSearch password"
node server.js
```
Git Bash:
```bash
OSD_USER=ndc-core-user OSD_PASS='…' node server.js
```
Open http://127.0.0.1:8787 (listens on localhost only). Optional env: `NDC_PORT`, `OSD_URL`, `OSD_TENANT`, `OSD_INDEX`.

## Booking failures page

`http://127.0.0.1:8787/failures` (tab **Booking failures**): every failed booking in a time range (24h / 3d / 7d / 30d
or custom, max 31 days), optionally for one agency or supplier. No refs needed.

- Sources: `handleBookingException` ("Booking Has been failed!"), `logBookingFailedBeforeSupplierCall` and
  `processMakePayment` with an `errorMessage`. Joined per session + booking ref (repeats within 10 min are one row with a
  count); "failed before supplier call" is folded into the real reason of the same session.
- Agency: from `processMakePayment`, else from any event in the session. Supplier: booking/pricing calls in the session.
- Reason = category from `rules.js` (same rules as the Exceptions page) + the original message + "what to do".
- Tiles, failures per hour/day stacked by reason, breakdowns by reason / agency / supplier (click to filter), table with
  links to the case (ref + time) and to Explain (session). Export CSV and PDF (filters applied).

## Booking ref + creation time, pay & book focus, PDF

Paste one ref per line followed by its creation time (copy two columns from Excel works):
```
NDCEG-BR-F261109TyCsIl   2026-11-09 16:53
NDCEG-BR-F261108XWLxWe   08/11/2026 12:50        (day first; seconds and AM/PM optional)
NDCEG-BR-F261112Qr8UGd                            (no time: the ref's whole day, -1..+3 days)
```
Times are your local time. A ref with a time is searched from 60 min before to 120 min after it (changeable).

Each session gets a **Pay & book** summary, taken around the time the ref itself was logged (a session can hold
several bookings): `bookAndPay` → `processMakePayment` (status / error) → payment gateway (BanqueMisr
`getsessionid` without `getTransactionStatus` = bank page opened, no result logged; TripLink `createCard`) →
supplier Hold/Book/BookAfterHold with HTTP code → booking exception. Book-after-hold bookings don't use
bookAndPay/processMakePayment and are marked "not used". In the side panel **Pay & book only** (on by default)
shows just those events and errors around the ref.

**Export PDF** (Overview card) downloads the table (visible verdicts only) as a landscape A4 PDF, rendered locally by
headless Edge (`PDF_BROWSER` to override). **Export CSV** includes the same pay & book columns.

## Many refs at once

Paste refs one per line (or separated by commas/spaces), up to 300 per run. Each ref is searched from 1 day before
to 3 days after the date in the ref (`NDCEG-BR-F261109…` = 2026-11-09); untick "time range from each ref's date"
to use From/To instead. Results are grouped by ref, with a count per verdict (click a count to hide/show it),
a list of refs with no logs ("Not found") and refs belonging to a different agency than the one entered.
**Export CSV** downloads every row, including not-found refs.

A ref can show several sessions: the booking session plus later ones that touched it (retrieve, ticketing,
viewing). Those later ones usually show as `no-booking`.

Each case shows a **journey** (Search → Fare confirm → Passengers → Reprice → Payment → Supplier booking):
filled = reached, ✕ = error / non-200 in that step, highlighted = where it stopped. Click a case for the full timeline
grouped by step. A "Mixed session" warning means the session id also carries other agencies' activity.

Shareable link: `http://127.0.0.1:8787/?refs=REF1,REF2&agency=AGN1` (optional `&theme=dark`, `&open=N` opens row N).
Light/dark toggle top right; `Ctrl+Enter` searches, `Esc` closes the side panel.

API: `POST /api/cases` with `{"refs": "ref1,ref2", "agency": "", "autoRange": true, "from": ISO, "to": ISO}`.

## Exceptions page

`http://127.0.0.1:8787/exceptions?cid=<correlationId>` (or the **⚡ Explain exceptions** button on a case).
For every distinct error in the session it shows: what happened, the likely cause, how to resolve it (Support / Dev
steps), the logged error, the events just before it, and the failing line of code with the stack trace (click any
`●` frame to see its code).

- Explanations come from `rules.js` (rule-based, built from the most frequent errors in the logs). "known pattern" =
  a specific rule matched; "inferred" = explained from the exception type + code location only. Add rules there.
- Code is read from the local git repo, not the working copy: `REPO_DIR` (default `D:\odeysys`) at `GIT_REF`
  (default `origin/master`, which matched production line numbers on 2026-11-15). Run `git fetch` to keep it current.
  If production runs another branch, set `GIT_REF` accordingly. "Open in VS Code" opens your working copy, whose lines may differ.
- Errors are ranked: **Blocks booking** → **May affect booking** → **Not booking-related** (noise such as broken pipe,
  search-statistics logging). Errors in the payment/booking steps are always ranked as blocking.
- A correlation id can span several bookings (e.g. an admin session); check the refs in "Just before" when it does.
- Nothing is sent outside your machine: no AI/LLM service is called.

- **Open in IntelliJ** opens the file in IntelliJ IDEA at the failing line. Because your working copy can be on another
  branch than `GIT_REF`, the server looks for the same code line in your working copy and opens the nearest match
  (the toast tells you if the line moved). It uses IntelliJ's built-in server (port 63342) when the odeysys project is
  open there, otherwise it runs `idea64.exe --line N <file>`. Only files from the repo can be opened.

Optional env: `REPO_DIR`, `GIT_REF`, `IDEA_EXE` (path to idea64.exe), `IDEA_PORT`.

### 💡 Suggest fix → fix branch → IntelliJ

Every code view on the Exceptions page has **💡 Suggest fix**. Suggestions are generated **locally by rules**
(`fixrules.js`) from the code at `GIT_REF`; no AI is used and nothing leaves your machine.

Rules so far:
| Exception | Suggestion |
|---|---|
| NPE on a parameter that comes from a stream lambda (`.map(x -> f(x))`) | `.filter(Objects::nonNull)` before the map (high) |
| NPE on a `UserSessionBean` read from the session | `throw new UnAuthorizedException("session expired")` = HTTP 401 (high) |
| NPE inside a log statement | only log when the values are present (high; low if the value is used again later) |
| NPE on another variable / getter chain | null guard: return early (void methods) or a clear IllegalStateException (low) |
| NumberFormatException on Integer/Long/Double parse | `NumberUtils.toInt/toLong/toDouble(x, 0)` (commons-lang3, already used) (medium) |
| IndexOutOfBounds on `list.get(n)` / `arr[n]` | size/length guard (low) |

Skipped automatically: injected beans/loggers, values created with `new`/builders, values the statement already
null-checks. Each edit must match the file exactly once or it cannot be applied.

**Apply & open in IntelliJ** writes the change into a separate worktree `FIX_WORKTREE` (default `D:\odeysys-fix`,
created from `GIT_REF` on first use) on the branch you name, then opens the file in IntelliJ at the change. Your
own branch/working copy is never touched; nothing is committed or pushed. Review, build with JDK 8, commit yourself.
Optional env: `FIX_WORKTREE`.

### Exception history

Exceptions page → **Exception history** (or **History →** on any exception card), or
`/exceptions?mode=history&exception=NullPointerException&method=getSearchResult&days=7`.
Exception name and method are exact (case-sensitive); suggestions come from the last 7 days of errors.

- Tiles: count in range, last 24h, last seen / first seen (logs keep ~30 days), and Still happening / Not seen in 24h.
- **Errors over time**, stacked by code location (top 5 + Other). Dashed markers = commits in `GIT_REF` that changed
  one of the failing lines (commit date, not deploy date).
- **Where in the code**: per location, estimated count and share, first → last seen, servers, Active / Stopped,
  commits that changed the line, and the code (with Open in IntelliJ).
- Servers, logged messages, and the 15 most recent sessions (Explain → opens the session view).
- Locations come from stack traces, which OpenSearch cannot aggregate: up to 120 events are sampled per time bucket and
  scaled to the bucket's count, so per-location numbers are estimates (marked `~`). Totals are exact.

## Verdicts

| Kind | Meaning |
|---|---|
| exception | `handleBookingException` logged ("Booking Has been failed!") – see the exception text |
| supplier | a supplier Hold/Book/BookAfterHold call returned non-200 |
| payment-error | `processMakePayment` logged an errorMessage (e.g. wallet balance, BSP not allowed) |
| payment-incomplete | `bookAndPay` reached the payment gateway but no supplier booking call followed (card payment not completed, or the callback isn't linked to this session) |
| not-booked-bm | Banque Misr card payment was used → counts as **not booked**, and overrides every other verdict (exception, supplier rejected, payment error, payment not completed, supplier OK). The original reason stays in the verdict text. |
| supplier-ok | supplier booking returned 200 and no Banque Misr payment – the problem is after the supplier (ticketing / DB update) |
| no-booking | session never reached bookAndPay |

Notes:
- The booking ref is often only inside an API response body, so the ref search is full-text across all fields.
- `bookingStatus: NOT_BOOKED` on `processMakePayment` is the starting status, not a failure.
- Payment-gateway logs carry no agency code; agency-only searches list the agency's `processMakePayment` sessions.
- Bank callbacks may run under a different `correlationId` and won't appear in the session timeline.
- Uses the OpenSearch Dashboards internal search API (`/internal/search/opensearch`), which can change between OSD versions.
