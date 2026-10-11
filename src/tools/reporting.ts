import { z } from 'zod';
import { ToastClient } from '../clients/toast.js';
import type { Order, Check, MenuItemSales } from '../types/index.js';

/**
 * Reporting & Analytics Tools
 */

// Toast keeps deleted orders/checks (e.g. a check opened in error and deleted
// while still OPEN) in ordersBulk. Toast's own Sales Summary leaves them out,
// so every report must skip them. Voided orders/checks are excluded from sales
// and reported separately as voids.
const isDeleted = (x: any) => !!x?.deleted;
const isVoided = (x: any) => !!x?.voided;
const liveChecks = (order: Order): Check[] =>
  isDeleted(order) || isVoided(order)
    ? []
    : (order.checks || []).filter(c => !isDeleted(c) && !isVoided(c));

// Gift card sales/reloads and house-account payments ride on a check and are
// included in check.amount, but they are not revenue. Toast's Sales Summary
// leaves them out of net sales, so every sales figure subtracts them.
const NON_SALES_TYPES = new Set(['TOAST_CARD_SELL', 'TOAST_CARD_RELOAD', 'HOUSE_ACCOUNT_PAY_BALANCE']);
const isNonSales = (sel: any) => !sel?.voided && NON_SALES_TYPES.has(sel?.selectionType);
const nonSalesAmount = (check: Check): number =>
  ((check as any).selections || []).reduce((s: number, sel: any) => s + (isNonSales(sel) ? (sel.price || 0) : 0), 0);
const netOf = (check: Check): number => (check.amount || 0) - nonSalesAmount(check);

// Hours must be bucketed in the restaurant's own time zone, not the server's
// (Railway runs in UTC, which pushed dinner into the 22:00-23:00 buckets).
const tzCache = new Map<string, string>();
export async function restaurantTimeZone(client: ToastClient, restaurantGuid: string): Promise<string> {
  const cached = tzCache.get(restaurantGuid);
  if (cached) return cached;
  let tz: string | undefined;
  try {
    const r: any = await client.get(`/restaurants/v1/restaurants/${restaurantGuid}`, { restaurantGuid });
    tz = r?.general?.timeZone || r?.timeZone;
  } catch {
    // fall through to the configured default
  }
  tz = tz || process.env.TOAST_TIMEZONE || 'America/New_York';
  tzCache.set(restaurantGuid, tz);
  return tz;
}
export function localHour(iso: string, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso));
  return Number(h) % 24;
}

export function registerReportingTools(client: ToastClient) {
  return [
    {
      name: 'toast_get_sales_summary',
      description: 'Get comprehensive sales summary for a business date',
      inputSchema: z.object({
        businessDate: z.number().describe('Business date in YYYYMMDD format'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        let totalSales = 0;
        let grossSales = 0;
        let netSales = 0;
        let taxAmount = 0;
        let tipAmount = 0;
        let discountAmount = 0;
        let voidAmount = 0;
        let refundAmount = 0;
        let guestCount = 0;
        let checkCount = 0;
        let deletedCheckCount = 0;
        let deletedAmount = 0;
        let nonSales = 0;

        orders.forEach(order => {
          if (isDeleted(order)) {
            order.checks?.forEach(check => { deletedCheckCount++; deletedAmount += check.amount || 0; });
            return;
          }
          if (order.voided) {
            voidAmount += order.checks.reduce((sum, check) => sum + (check.totalAmount || 0), 0);
            return;
          }

          order.checks.forEach(check => {
            if (isDeleted(check)) { deletedCheckCount++; deletedAmount += check.amount || 0; }
            else if (isVoided(check)) voidAmount += check.totalAmount || 0;
          });
          const checks = liveChecks(order);
          if (!checks.length) return;

          guestCount += order.numberOfGuests || 0;
          checkCount += checks.length;

          checks.forEach(check => {
            // check.amount is Toast's net: already reduced by BOTH check-level
            // and item-level discounts. Start there, then add every discount
            // back into gross so gross - discounts = net (issue #1: check-level
            // discounts used to be subtracted a second time).
            grossSales += netOf(check);
            nonSales += nonSalesAmount(check);
            taxAmount += check.taxAmount || 0;
            totalSales += check.totalAmount || 0;

            check.payments?.forEach(payment => {
              tipAmount += payment.tipAmount || 0;
              if (payment.refund) {
                refundAmount += payment.refund.refundAmount || 0;
              }
            });

            // The same applied discount can surface on the check and again on
            // the selections it was prorated across; count each guid once.
            const seenDiscounts = new Set<string>();
            const countDiscount = (d: any) => {
              if (!d) return;
              if (d.guid) {
                if (seenDiscounts.has(d.guid)) return;
                seenDiscounts.add(d.guid);
              }
              const amt = d.discountAmount || 0;
              discountAmount += amt;
              grossSales += amt;
            };

            check.appliedDiscounts?.forEach(countDiscount);
            check.selections?.forEach(selection => {
              if ((selection as any).voided) return;
              (selection as any).appliedDiscounts?.forEach(countDiscount);
            });
          });
        });

        netSales = grossSales - discountAmount;

        return {
          businessDate: args.businessDate,
          totalSales,
          grossSales,
          netSales,
          taxAmount,
          tipAmount,
          discountAmount,
          voidAmount,
          refundAmount,
          guestCount,
          checkCount,
          excludedDeletedChecks: deletedCheckCount,
          excludedDeletedAmount: deletedAmount,
          excludedGiftCardAndHouseAccount: nonSales,
          averageCheck: checkCount > 0 ? netSales / checkCount : 0,
          averageGuestSpend: guestCount > 0 ? netSales / guestCount : 0,
        };
      },
    },

    {
      name: 'toast_get_hourly_sales',
      description: 'Get sales broken down by hour for a business date',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const timeZone = await restaurantTimeZone(client, restGuid);
        type Bucket = { sales: number; totalSales: number; orders: number; guests: number };
        const empty = (): Bucket => ({ sales: 0, totalSales: 0, orders: 0, guests: 0 });
        const hourlyData: Record<number, Bucket> = {};

        orders.forEach(order => {
          const checks = liveChecks(order);
          if (!checks.length) return;

          const hour = localHour(order.openedDate, timeZone);
          const b = (hourlyData[hour] ??= empty());
          b.orders++;
          b.guests += order.numberOfGuests || 0;
          checks.forEach(check => {
            b.sales += netOf(check);                 // net: after discounts, before tax and tips
            b.totalSales += check.totalAmount || 0;  // incl. tax (and any amount Toast rolls into total)
          });
        });

        const hourlyArray = Array.from({ length: 24 }, (_, hour) => ({ hour, ...(hourlyData[hour] || empty()) }));

        return {
          businessDate: args.businessDate,
          timeZone,
          salesBasis: 'net (check amount after discounts, before tax and tips)',
          hourlyBreakdown: hourlyArray,
        };
      },
    },

    {
      name: 'toast_get_item_sales_report',
      description: 'Get sales report for menu items',
      inputSchema: z.object({
        businessDate: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        limit: z.number().optional().describe('Return top N items'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate?: number; startDate?: string; endDate?: string; limit?: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
            startDate: args.startDate,
            endDate: args.endDate,
          }
        );

        const itemSales = new Map<string, MenuItemSales>();

        orders.forEach(order => {
          liveChecks(order).forEach(check => {
            (check.selections || []).forEach((selection: any) => {
              if (selection.voided || isNonSales(selection)) return;

              // Group on the menu item reference guid (selections carry the item
              // as a reference object, not a flat itemGuid), falling back to the
              // display name so unmapped items still bucket by name.
              const sel = selection as any;
              const key: string = sel.item?.guid || selection.displayName || 'unknown';
              // preDiscountPrice is the true gross; price is already net of discounts.
              const gross: number = sel.preDiscountPrice ?? selection.price ?? 0;
              const net: number = selection.price ?? gross;

              const existing = itemSales.get(key);
              if (existing) {
                existing.quantity += selection.quantity;
                existing.grossSales += gross;
                existing.netSales += net;
              } else {
                itemSales.set(key, {
                  itemGuid: sel.item?.guid || '',
                  itemName: selection.displayName || 'Unknown item',
                  quantity: selection.quantity,
                  grossSales: gross,
                  netSales: net,
                });
              }
            });
          });
        });

        let items = Array.from(itemSales.values());
        items.sort((a, b) => b.netSales - a.netSales);

        if (args.limit) {
          items = items.slice(0, args.limit);
        }

        return {
          items,
          totalItems: items.length,
          totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
          totalSales: items.reduce((sum, item) => sum + item.netSales, 0),
        };
      },
    },

    {
      name: 'toast_get_payment_type_report',
      description: 'Get breakdown of sales by payment type',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const paymentTypes: Record<string, { amount: number; tipAmount: number; count: number }> = {};

        orders.forEach(order => {
          if (isDeleted(order)) return;
          order.checks.forEach(check => {
            if (isDeleted(check)) return;
            check.payments?.forEach(payment => {
              const type = payment.type || 'UNKNOWN';
              if (!paymentTypes[type]) {
                paymentTypes[type] = { amount: 0, tipAmount: 0, count: 0 };
              }
              paymentTypes[type].amount += payment.amount;
              paymentTypes[type].tipAmount += payment.tipAmount || 0;
              paymentTypes[type].count++;
            });
          });
        });

        return {
          businessDate: args.businessDate,
          paymentTypes,
        };
      },
    },

    {
      name: 'toast_get_discount_report',
      description: 'Get report on discounts applied',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const discounts: Record<string, { name: string; amount: number; count: number }> = {};

        // Same applied discount can appear on the check and on the selections
        // it was prorated across; count each guid once (matches sales summary).
        const seenDiscounts = new Set<string>();
        const record = (discount: any) => {
          if (!discount) return;
          if (discount.guid) {
            if (seenDiscounts.has(discount.guid)) return;
            seenDiscounts.add(discount.guid);
          }
          // Applied discounts reference the discount config as an object;
          // fall back to name so nothing lands under the literal "undefined".
          const key: string = discount?.discount?.guid || discount?.discountGuid || discount?.name || 'unknown';
          if (!discounts[key]) {
            discounts[key] = { name: discount?.name || 'Unknown discount', amount: 0, count: 0 };
          }
          discounts[key].amount += discount?.discountAmount || 0;
          discounts[key].count++;
        };

        orders.forEach(order => {
          liveChecks(order).forEach(check => {
            check.appliedDiscounts?.forEach(record);
            // Item-level comps (loyalty rewards, single-item discounts) live on
            // the selection, not the check. Count both.
            check.selections?.forEach(selection => {
              if (!(selection as any).voided) {
                (selection as any).appliedDiscounts?.forEach(record);
              }
            });
          });
        });

        const discountArray = Object.entries(discounts).map(([guid, data]) => ({
          discountGuid: guid,
          ...data,
        }));

        discountArray.sort((a, b) => b.amount - a.amount);

        return {
          businessDate: args.businessDate,
          discounts: discountArray,
          totalDiscountAmount: discountArray.reduce((sum, d) => sum + d.amount, 0),
        };
      },
    },

    {
      name: 'toast_get_void_report',
      description: 'Get report on voided orders and items',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const voidedOrders = orders.filter(o => o.voided);
        const voidedSelections: any[] = [];

        orders.forEach(order => {
          order.checks.forEach(check => {
            check.selections.forEach(selection => {
              if (selection.voided) {
                voidedSelections.push({
                  orderGuid: order.guid,
                  itemName: selection.displayName,
                  quantity: selection.quantity,
                  amount: selection.price,
                  voidDate: selection.voidDate,
                });
              }
            });
          });
        });

        const totalVoidedAmount =
          voidedOrders.reduce((sum, order) =>
            sum + order.checks.reduce((checkSum, check) => checkSum + (check.totalAmount || 0), 0),
          0) +
          voidedSelections.reduce((sum, sel) => sum + sel.amount, 0);

        return {
          businessDate: args.businessDate,
          voidedOrderCount: voidedOrders.length,
          voidedSelectionCount: voidedSelections.length,
          totalVoidedAmount,
          voidedOrders: voidedOrders.map(o => ({
            orderGuid: o.guid,
            voidDate: o.voidDate,
            amount: o.checks.reduce((sum, c) => sum + (c.totalAmount || 0), 0),
          })),
          voidedSelections,
        };
      },
    },
  ];
}
