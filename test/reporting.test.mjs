// Issue #1: check-level discounts were subtracted twice in toast_get_sales_summary.
// Run: npm test (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerReportingTools } from '../dist/tools/reporting.js';

const disc = (guid, discountAmount, name = 'Disc') => ({
  guid, discountGuid: `cfg-${name}`, name, amount: discountAmount, discountAmount,
});

// Toast's check.amount is already net of every discount on the check.
// Two checks:
//  - check 1: $100 of items, $20 check-level discount            -> amount 80
//  - check 2: $50 of items, $5 item-level comp on one selection   -> amount 45
// Web "Net Sales Summary" would show gross 150, discounts 25, net 125.
const orders = [
  {
    guid: 'o1', voided: false, numberOfGuests: 2,
    checks: [
      {
        guid: 'c1', amount: 80, taxAmount: 6.6, totalAmount: 86.6,
        appliedDiscounts: [disc('ad-1', 20, '20 off')],
        selections: [
          { guid: 's1', voided: false, preDiscountPrice: 60, price: 48 },
          { guid: 's2', voided: false, preDiscountPrice: 40, price: 32 },
        ],
        payments: [{ tipAmount: 15 }],
      },
      {
        guid: 'c2', amount: 45, taxAmount: 3.71, totalAmount: 48.71,
        appliedDiscounts: [],
        selections: [
          { guid: 's3', voided: false, preDiscountPrice: 50, price: 45,
            appliedDiscounts: [disc('ad-2', 5, 'Loyalty')] },
          // voided selection carrying a discount must be ignored
          { guid: 's4', voided: true, preDiscountPrice: 10, price: 0,
            appliedDiscounts: [disc('ad-void', 10, 'Void comp')] },
        ],
        payments: [],
      },
    ],
  },
  // voided order: excluded from sales, counted in voidAmount
  { guid: 'o2', voided: true, numberOfGuests: 1, checks: [{ guid: 'c3', amount: 30, totalAmount: 32.5, appliedDiscounts: [disc('ad-3', 5)] }] },
];

function fakeClient(data) {
  return {
    getRestaurantGuid: () => 'rest-1',
    async getAllPages() { return data; },
    async get() { throw new Error('not expected'); },
  };
}
const toolsFor = (client) => Object.fromEntries(registerReportingTools(client).map(t => [t.name, t]));
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} != ${b}`);

test('sales summary counts check-level discounts once', async () => {
  const tools = toolsFor(fakeClient(orders));
  const out = await tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
  close(out.grossSales, 150);
  close(out.discountAmount, 25);
  close(out.netSales, 125);            // was 105 before the fix (20 subtracted twice)
  close(out.netSales, 80 + 45);        // net == sum of check.amount
  close(out.totalSales, 86.6 + 48.71);
  close(out.tipAmount, 15);
  close(out.voidAmount, 32.5);
  assert.equal(out.checkCount, 2);
  assert.equal(out.guestCount, 2);
});

test('a discount surfaced at both check and selection level is counted once', async () => {
  const shared = disc('ad-shared', 10, 'Manager comp');
  const data = [{
    guid: 'o1', voided: false, numberOfGuests: 1,
    checks: [{
      guid: 'c1', amount: 90, taxAmount: 0, totalAmount: 90,
      appliedDiscounts: [shared],
      selections: [{ guid: 's1', voided: false, preDiscountPrice: 100, price: 90, appliedDiscounts: [shared] }],
      payments: [],
    }],
  }];
  const tools = toolsFor(fakeClient(data));
  const summary = await tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
  close(summary.grossSales, 100);
  close(summary.discountAmount, 10);
  close(summary.netSales, 90);
  const report = await tools.toast_get_discount_report.handler({ businessDate: 20260911 });
  const total = report.discounts.reduce((s, d) => s + d.amount, 0);
  close(total, 10);
  assert.equal(report.discounts[0].count, 1);
});

// Deleted checks (opened in error and deleted while still OPEN) stay in
// ordersBulk but are not sales. Toast's Sales Summary excludes them.
test('deleted orders and checks are excluded from sales, guests and items', async () => {
  const data = [
    { guid: 'o1', voided: false, deleted: false, numberOfGuests: 2, openedDate: '2026-10-09T23:10:00.000+0000',
      checks: [{ guid: 'c1', amount: 100, taxAmount: 8, totalAmount: 108, deleted: false, voided: false,
        selections: [{ guid: 's1', voided: false, displayName: 'Burger', item: { guid: 'i1' }, quantity: 2, preDiscountPrice: 100, price: 100 }],
        payments: [{ tipAmount: 20 }] }] },
    // deleted order: everything on it ignored
    { guid: 'o2', voided: false, deleted: true, numberOfGuests: 1, openedDate: '2026-10-09T23:20:00.000+0000',
      checks: [{ guid: 'c2', amount: 25.75, taxAmount: 1.75, totalAmount: 27.5, deleted: true, voided: false, paymentStatus: 'OPEN',
        selections: [{ guid: 's2', voided: false, displayName: 'Burger', item: { guid: 'i1' }, quantity: 1, preDiscountPrice: 25.75, price: 25.75 }],
        payments: [] }] },
    // live order with one deleted check and one live check
    { guid: 'o3', voided: false, deleted: false, numberOfGuests: 1, openedDate: '2026-10-09T16:05:00.000+0000',
      checks: [
        { guid: 'c3', amount: 40, taxAmount: 3, totalAmount: 43, deleted: false, voided: false, selections: [], payments: [] },
        { guid: 'c4', amount: 12, taxAmount: 1, totalAmount: 13, deleted: true, voided: false, selections: [], payments: [] },
      ] },
  ];
  const tools = toolsFor(fakeClient(data));
  const s = await tools.toast_get_sales_summary.handler({ businessDate: 20261009 });
  close(s.netSales, 140);
  assert.equal(s.guestCount, 3);
  assert.equal(s.checkCount, 2);
  assert.equal(s.excludedDeletedChecks, 2);
  close(s.excludedDeletedAmount, 37.75);
  const items = await tools.toast_get_item_sales_report.handler({ businessDate: 20261009 });
  assert.equal(items.items[0].quantity, 2);
  close(items.totalSales, 100);
});

test('hourly sales are net and bucketed in the restaurant time zone', async () => {
  process.env.TOAST_TIMEZONE = 'America/New_York';
  const data = [
    { guid: 'o1', voided: false, deleted: false, numberOfGuests: 2, openedDate: '2026-10-09T23:10:00.000+0000',
      checks: [{ guid: 'c1', amount: 100, taxAmount: 8, totalAmount: 108, deleted: false, voided: false, selections: [], payments: [{ tipAmount: 20 }] }] },
    { guid: 'o2', voided: false, deleted: true, numberOfGuests: 1, openedDate: '2026-10-09T23:20:00.000+0000',
      checks: [{ guid: 'c2', amount: 25.75, taxAmount: 1.75, totalAmount: 27.5, deleted: true, voided: false, selections: [], payments: [] }] },
  ];
  const tools = toolsFor(fakeClient(data));
  const h = await tools.toast_get_hourly_sales.handler({ businessDate: 20261009, restaurantGuid: 'tz-test-1' });
  assert.equal(h.timeZone, 'America/New_York');
  const at = (hr) => h.hourlyBreakdown.find(x => x.hour === hr);
  close(at(19).sales, 100);       // 23:10 UTC = 7:10pm EDT
  close(at(19).totalSales, 108);
  assert.equal(at(19).guests, 2);
  close(at(23).sales, 0);         // nothing left in the UTC hour
});

test('gift card sales/reloads and house account payments are not net sales', async () => {
  const data = [
    { guid: 'o1', voided: false, deleted: false, numberOfGuests: 2, openedDate: '2026-10-09T23:10:00.000+0000',
      checks: [{ guid: 'c1', amount: 300, taxAmount: 8, totalAmount: 308, deleted: false, voided: false, payments: [],
        selections: [
          { guid: 's1', voided: false, selectionType: 'NONE', displayName: 'Burger', item: { guid: 'i1' }, quantity: 1, preDiscountPrice: 100, price: 100 },
          { guid: 's2', voided: false, selectionType: 'TOAST_CARD_RELOAD', displayName: 'Add Value ($)', quantity: 1, preDiscountPrice: 200, price: 200 },
        ] }] },
  ];
  const tools = toolsFor(fakeClient(data));
  const s = await tools.toast_get_sales_summary.handler({ businessDate: 20261009 });
  close(s.netSales, 100);
  close(s.excludedGiftCardAndHouseAccount, 200);
  const h = await tools.toast_get_hourly_sales.handler({ businessDate: 20261009, restaurantGuid: 'tz-test-1' });
  close(h.hourlyBreakdown.reduce((a, x) => a + x.sales, 0), 100);
  const items = await tools.toast_get_item_sales_report.handler({ businessDate: 20261009 });
  assert.equal(items.items.length, 1);
});
