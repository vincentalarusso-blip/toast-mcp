// Dashboard sync: aggregation ties to net, business-date rollover, scheduling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateDay, currentBusinessDate, daypartFor, addDays, DashboardSync } from '../dist/tools/dashboard.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} != ${b}`);
const sum = (m, i) => Object.values(m).reduce((s, v) => s + v[i], 0);
const cfg = { tz: 'America/New_York', service: { 'svc-d': 'Dinner' }, schedules: undefined };

const orders = [
  { guid: 'o1', numberOfGuests: 2, openedDate: '2026-10-09T23:10:00.000+0000',
    revenueCenter: { guid: 'rc-bar' }, serviceArea: null, restaurantService: { guid: 'svc-d' },
    checks: [{ guid: 'c1', amount: 310, taxAmount: 8, totalAmount: 318,
      appliedDiscounts: [{ guid: 'd1', discountAmount: 20 }],
      appliedServiceCharges: [{ chargeAmount: 10, gratuity: false }, { chargeAmount: 30, gratuity: true }],
      payments: [{ tipAmount: 15 }],
      selections: [
        { guid: 's1', selectionType: 'NONE', displayName: 'Burger', salesCategory: { guid: 'food' }, itemGroup: { guid: 'mains' }, quantity: 1, preDiscountPrice: 80, price: 60 },
        { guid: 's2', selectionType: 'NONE', displayName: 'Martini', salesCategory: { guid: 'liq' }, itemGroup: { guid: 'cocktails' }, quantity: 2, preDiscountPrice: 40, price: 40 },
        { guid: 's3', selectionType: 'TOAST_CARD_RELOAD', displayName: 'Add Value ($)', quantity: 1, price: 200 },
        { guid: 's4', voided: true, selectionType: 'NONE', displayName: 'Fries', salesCategory: { guid: 'food' }, quantity: 1, price: 9 },
      ] }] },
  { guid: 'o2', deleted: true, numberOfGuests: 1, openedDate: '2026-10-09T23:20:00.000+0000',
    checks: [{ guid: 'c2', amount: 25.75, selections: [] }] },
  { guid: 'o3', voided: true, numberOfGuests: 1, checks: [{ guid: 'c3', amount: 10, totalAmount: 11, selections: [] }] },
];

test('aggregation: net excludes gift cards, deleted and voided; every breakdown ties to net', () => {
  const a = aggregateDay(orders, cfg, 20261009);
  close(a.t.net, 110);              // 310 - 200 gift card
  close(a.t.gift, 200);
  close(a.t.svc, 10);
  close(a.t.grat, 30);
  close(a.t.disc, 20);
  close(a.t.gross, 130);
  close(a.t.del, 25.75);
  close(a.t.voids, 11);
  assert.equal(a.t.guests, 2);
  assert.equal(a.t.checks, 1);
  close(sum(a.seg, 0), 110);
  close(sum(a.cat, 0), 110);        // food 60 + liquor 40 + service charge 10
  close(sum(a.hrs, 0), 110);
  close(sum(a.items, 1) + a.t.svc, 110);
  assert.deepEqual(a.seg['rc-bar||Dinner'], [110, 2, 1, 1]);
  assert.deepEqual(a.hrs['19|rc-bar'], [110, 2, 1]); // 23:10 UTC = 7pm EDT
  assert.deepEqual(a.items['rc-bar||Dinner|liq|cocktails|Martini'], [2, 40, 40]);
  assert.ok(!Object.keys(a.items).some(k => k.includes('Add Value') || k.includes('Fries')));
});

test('business date rolls over at the closeout hour, in the location time zone', () => {
  // 2026-10-11 03:30 EDT = 07:30 UTC: still the 10th before a 4am closeout
  assert.equal(currentBusinessDate(new Date('2026-10-11T07:30:00Z'), 'America/New_York', 4), 20261010);
  assert.equal(currentBusinessDate(new Date('2026-10-11T08:30:00Z'), 'America/New_York', 4), 20261011);
  // same instant in Denver is 1:30am on the 11th -> business date the 10th
  assert.equal(currentBusinessDate(new Date('2026-10-11T07:30:00Z'), 'America/Denver', 4), 20261010);
  assert.equal(addDays(20260301, -1), 20260228);
});

test('daypart falls back to the location schedule by local time', () => {
  const schedules = {
    weekSchedule: { friday: 'A' },
    daySchedules: { A: { services: [
      { name: 'Lunch', hours: { startTime: '11:00:00.000', endTime: '16:00:00.000' } },
      { name: 'Dinner', hours: { startTime: '16:00:00.000', endTime: '23:00:00.000' } },
      { name: 'Late Night', hours: { startTime: '23:00:00.000', endTime: '03:59:00.000' }, overnight: true },
    ] } },
  };
  const c = { tz: 'America/New_York', service: {}, schedules };
  assert.equal(daypartFor({ openedDate: '2026-10-09T16:30:00.000+0000' }, c, 20261009), 'Lunch');      // 12:30
  assert.equal(daypartFor({ openedDate: '2026-10-09T23:30:00.000+0000' }, c, 20261009), 'Dinner');     // 19:30
  assert.equal(daypartFor({ openedDate: '2026-10-10T04:30:00.000+0000' }, c, 20261009), 'Late Night'); // 00:30
  assert.equal(daypartFor({ openedDate: '2026-10-09T12:00:00.000+0000' }, c, 20261009), 'Unassigned'); // 08:00
});

function fakeClient(byDate) {
  return {
    axiosInstance: { get: async () => ({ data: [], headers: {} }) },
    getRestaurantGuid: () => 'L1',
    async get(endpoint, params) {
      if (endpoint.startsWith('/restaurants/v1/restaurants/')) {
        return { general: { timeZone: 'America/New_York', closeoutHour: 4, firstBusinessDate: 20261006 } };
      }
      if (endpoint === '/menus/v2/menus') return { menus: [] };
      if (endpoint === '/orders/v2/ordersBulk') return params.page === 1 ? (byDate[params.businessDate] || []) : [];
      throw new Error(`unexpected ${endpoint}`);
    },
  };
}

test('sync: backfills from first business date, marks current day partial, serves summary and items', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  const client = fakeClient({ 20261009: orders });
  const sync = new DashboardSync(client, { dir, locations: [{ guid: 'L1', name: 'Test Outlet' }], start: '2026-01-01', refreshHours: 4 });
  await sync.planCycle();
  await sync.work();
  const st = sync.status({ date: 20261009 });
  const loc = st.locations[0];
  assert.equal(loc.first, 20261006);           // nothing before Toast's first business date
  assert.ok(loc.last >= 20261009);
  assert.equal(loc.partial.length, 1);         // only the open business date is partial
  close(st.date[0].totals.net, 110);
  const s = JSON.parse(sync.buildSummary().json);
  const day = s.days.find(r => r[0] === 20261009);
  close(day[2], 110);
  assert.equal(day[12], 1);                    // final
  const m = JSON.parse(sync.buildMonth('202610').json);
  assert.equal(m.rows.filter(r => r[0] === 20261009).length, 2);
  // a second cycle re-pulls only the current day (and nothing already final)
  const before = sync.state.fetched;
  await sync.planCycle();
  await sync.work();
  assert.equal(sync.state.fetched - before, 1);
  // reload from disk keeps the data
  const again = new DashboardSync(client, { dir, locations: [{ guid: 'L1', name: 'Test Outlet' }], start: '2026-01-01' });
  close(JSON.parse(again.buildSummary().json).days.find(r => r[0] === 20261009)[2], 110);
});

test('dataPart splits the summary by month and pages items, and the pieces add back up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  const sync = new DashboardSync(fakeClient({ 20261009: orders }), { dir, locations: [{ guid: 'L1', name: 'Test Outlet' }], start: '2026-01-01' });
  await sync.planCycle(); await sync.work();
  const meta = sync.dataPart({ part: 'meta' });
  assert.ok(meta.etag && meta.months.includes('202610') && !meta.days);
  const full = JSON.parse(sync.buildSummary().json);
  const parts = meta.months.map(m => sync.dataPart({ part: 'summary', month: m }));
  assert.equal(parts.reduce((s, p) => s + p.days.length, 0), full.days.length);
  assert.equal(parts.reduce((s, p) => s + p.cat.length, 0), full.cat.length);
  const items = sync.dataPart({ part: 'items', month: '202610', page: 0 });
  assert.equal(items.pages, 1);
  assert.equal(items.rows.length, 2);
  assert.throws(() => sync.dataPart({ part: 'summary', month: '2026' }));
});
