# Changelog

Check your deployed version at `https://<your-domain>/health`.

## 1.4.0 (2026-10-11)

- **`toast_dashboard_data`** (MCP tool): the dashboard feed in pieces small enough for a tool
  result (`meta`, then `summary` per month, then `items` per month and page), so the dashboard
  can run as a pinned Claude page through the Toast connector. Results are sent compact.
- **`GET /dashboard/?key=…`** serves the dashboard page from `dashboard/index.html` in the
  deployed repo (override with `DASHBOARD_PAGE`), behind the same `DASHBOARD_KEY`.

## 1.3.0 (2026-10-11)

- **F&B dashboard sync** (`src/tools/dashboard.ts`, http mode). The server keeps
  its own store of daily Toast sales per location on disk (`DATA_DIR`, default
  `/data`, a Railway volume) and serves it to the dashboard:
  - backfills every business date from `DASHBOARD_START` (default 2026-01-01) once,
    newest first;
  - every `DASHBOARD_REFRESH_HOURS` (default 4) pulls today's business date only;
  - after each closeout, pulls the day that just closed one final time; final days
    are not pulled again unless `toast_dashboard_refresh` asks for them.
  - Stores net, gross, discounts, tax, tips, service charges, gift cards, guests,
    checks, plus net by revenue center, service area, daypart and sales category,
    net by hour, and item quantities and net. Item net + service charges = net.
  - `GET /dashboard/data.json` and `GET /dashboard/items/YYYYMM.json` (need
    `DASHBOARD_KEY` as `?key=` or `x-dashboard-key`), gzip, ETag, CORS.
    `GET /dashboard/status` is public and has no sales figures.
  - MCP tools `toast_dashboard_status` and `toast_dashboard_refresh`.
  - Locations default to the CMH list; override with `DASHBOARD_LOCATIONS`
    (JSON `[{"guid","name"}]`). `DASHBOARD_SYNC=off` disables it.

## 1.2.4 (2026-10-11)

- **Gift card sales and reloads and house-account payments are not net sales.**
  They ride on a check and are included in `check.amount`, but Toast's Sales
  Summary leaves them out. The sales summary, hourly and item reports now
  subtract them; the summary reports them as `excludedGiftCardAndHouseAccount`.
  Verified: Sister Ship 2026-10-09 now $11,355.07, matching Toast Web.

## 1.2.3 (2026-10-11)

- **Deleted orders and checks no longer count as sales.** Toast keeps them in
  `ordersBulk` (for example a check opened in error and deleted while still
  OPEN), but Toast's own Sales Summary leaves them out. `toast_get_sales_summary`,
  `toast_get_hourly_sales`, `toast_get_item_sales_report`,
  `toast_get_discount_report` and `toast_get_payment_type_report` now skip
  them. Voided checks inside a live order are moved to `voidAmount`. The sales
  summary reports what it excluded in `excludedDeletedChecks` and
  `excludedDeletedAmount`. Verified on live data: Swim Club, 2026-10-09 now
  returns $1,846.23 net and 49 guests, matching Toast Web (was $1,871.98 / 50).
- **`toast_get_hourly_sales` reports net sales in the restaurant's time zone.**
  `sales` is now the check amount (after discounts, before tax and tips);
  the old tax-inclusive figure is kept as `totalSales`. Hours are bucketed in
  the restaurant's configured time zone instead of the server clock (UTC on
  Railway, which pushed dinner into 22:00-23:00). Falls back to
  `TOAST_TIMEZONE`, then `America/New_York`. The response includes `timeZone`.
- **Restaurant tools honor `restaurantGuid`.** `toast_get_restaurant_info`,
  `toast_list_tables`, `toast_get_table`, service areas, dining options and
  revenue centers ignored the per-call GUID and always queried the default
  location.

## 1.2.2 (2026-10-08)

- **Menu tools now read the real Menus v2 shape.** 1.2.1 unwrapped the
  `{ menus: [...] }` document but still walked `groups` and `items`. Toast
  names them `menuGroups` (nested, up to three deep) and `menuItems`, so on live
  data `toast_search_menu_items` returned 0 items, `toast_list_menu_groups`
  and `toast_get_items_by_category` came back empty, and
  `toast_get_86d_items` and `toast_list_low_stock_items` missed everything.
  All menu walks now go through `allGroups()` / `allItems()`, which follow
  nested groups and still accept the old `groups`/`items` spelling.
- **`toast_search_menu_items` returns each item once.** The same item guid sits
  on every menu that lists it, so results are deduped by guid with a
  `foundIn` list of `{ menuGuid, menuName, menuGroupGuid, menuGroupName }`.
- **`toast_list_low_stock_items`** checks each item guid once, including items
  in nested groups.
- **Types** use `menuGroups` / `menuItems` (legacy spellings kept optional).
- **Tests:** `test/menus.test.mjs` now uses a fixture shaped after a live
  document (nested groups, an item on two menus, an empty menu).

## 1.2.1 (2026-09-16)

Both fixes come from production reports by @luizggonsales (issues #1 and #2).

- **Sales summary no longer double-counts check-level discounts** (#1).
  `check.amount` is already net of check-level discounts, but the summary
  subtracted them again, so `netSales` came in low by exactly the check-level
  discount total. Gross is now rebuilt by adding every discount back onto
  `check.amount`, and an applied discount that appears on both the check and
  its selections is counted once. The discount report dedupes the same way so
  the two tools still agree.
- **Menu tools work again** (#2). `GET /menus/v2/menus` returns a document with
  the menus under `.menus`; the tools treated it as a bare array, so
  `toast_list_menu_groups`, `toast_search_menu_items`, `toast_get_items_by_category`,
  `toast_get_86d_items` and `toast_list_low_stock_items` threw
  `menus.flatMap is not a function`, and `toast_list_menus` returned the
  container with `count: undefined`. All of them now unwrap the document.
  `toast_get_menu` and `toast_get_menu_item` called per-object endpoints that
  Menus v2 does not have; they now select from the document instead.
- **Unit tests added** (`npm test`): fake-client tests for the menu tools and
  the discount arithmetic, alongside the live gauntlet.

## 1.2.0 (2026-09-01)

Every fix below was found by testing against live production restaurants and is
verified by the new validation gauntlet (`npm run validate:live`), which now
passes 12/12 against a real account.

- **Item sales report rebuilt.** It previously collapsed every selection into a
  single arbitrary bucket (grouping on a field Toast never populates), reported
  discount-net prices as gross, and subtracted discounts twice. It now groups on
  the menu item reference, sums preDiscountPrice as gross, and reports price as
  net. Real per-item results for the first time.
- **Discount report counts item-level comps.** Loyalty rewards and single-item
  discounts live on the selection, not the check, and were invisible. The report
  now reconciles to manager logs to the cent, and no longer emits literal
  "undefined" discount ids.
- **Sales summary counts item-level comps** the same way, so discountAmount and
  grossSales agree with the discount report and with Toast Web.
- **Schema fix for every optional numeric parameter.** Optional numbers were
  advertised as strings and then rejected ("Expected number, received string"),
  making those parameters unreachable. The advertised schema now matches
  validation, and numeric strings from older clients are coerced.
- **Pagination is concurrent and capped.** Order-scanning tools fetch pages in
  batches of 4 with a 60-page safety cap, ending multi-minute hangs on
  customer search, loyalty, and top-customer tools. Scan windows tightened.
- **Validation gauntlet added** (`scripts/validate-live.mjs`): schema sweep of
  every read tool plus arithmetic invariants (hourly sums to the day, gross
  minus discounts equals net, discount report equals summary, item gross >= net).

## 1.1.1 (2026-08-30)

- Per-call `restaurantGuid` override fixed (auth interceptor no longer stomps
  the Toast-Restaurant-External-ID header). Multi-location queries work.
- Named locations: set `TOAST_LOCATIONS` to {"Name": "guid", ...} and every
  tool accepts location names; adds `toast_get_locations`.

## 1.1.0 (2026-08-30)

- Remote mode: streamable HTTP transport with shared-secret auth for use as a
  claude.ai custom connector. Write tools disabled by default; three-lock
  safety (env flag, dry-run default, per-call confirm_write) when enabled.

## 1.0.x (2026-08-28)

- Fixed the authentication response parsing that prevented the original
  project from ever completing a live API call, plus list endpoints
  (ordersBulk), restaurant scoping headers, the labor report, and type errors.
