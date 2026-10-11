import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ToastClient } from '../clients/toast.js';
import { fetchMenus, allGroups, menuItemsOf } from './menus.js';
import { localHour } from './reporting.js';

/**
 * Dashboard sync: keeps a per-location, per-business-date store of aggregated
 * Toast sales on disk (DATA_DIR, a Railway volume) and serves it to the
 * F&B Sales dashboard.
 *
 *  - Backfill: every business date from DASHBOARD_START (default 2026-01-01)
 *    to yesterday, once.
 *  - Every DASHBOARD_REFRESH_HOURS (default 4): today's business date only.
 *  - Once after each closeout: one final pull of the day that just closed.
 *    Final days are never pulled again unless asked (toast_dashboard_refresh).
 *
 * Net sales = check.amount minus gift card sales/reloads and house-account
 * payments, after deleted and voided orders/checks are removed. This matched
 * Toast's Sales Summary for all nine outlets on Oct 9, 2026. check.amount
 * includes non-gratuity service charges, so item net + service charges = net.
 */

// ---------------------------------------------------------------- locations
export interface Location { guid: string; name: string }
const DEFAULT_LOCATIONS: Location[] = [
  { guid: '95f2c901-6127-4224-822a-678eab2a3dd3', name: 'Swim Club' },
  { guid: '53a15b61-f2bb-4de0-8845-9376a00b1ed9', name: 'Swim Club - Pool' },
  { guid: 'b5f6bfe9-5426-402b-bed3-276c8706b940', name: 'Beachside IRD' },
  { guid: 'd9ba7627-b624-4191-8851-231a050f723b', name: 'Sure Hand' },
  { guid: '917ac2b5-e616-45ad-8136-225b43f228b2', name: 'FJAC Pool' },
  { guid: '2705a6eb-b0eb-4bca-9969-24e8721ac6d8', name: 'FJAC IRD' },
  { guid: '1bdbdacb-f980-4a5b-990d-2ea35af248c5', name: 'Newes From America' },
  { guid: '05c419c4-95f4-414e-a73d-80a4c94a617f', name: 'Pelican Club' },
  { guid: '8959bff9-0105-4bc7-8d3a-2861f0acaff1', name: 'MV Pool' },
  { guid: '3950f1d6-e6c6-4fd8-9b9c-1341a74cbdfc', name: 'MV IRD' },
  { guid: 'db5fa603-a606-4497-b3b8-09ee425e38c8', name: 'Sister Ship' },
  { guid: '47c05307-9875-4af5-af68-b17f407220fb', name: 'Cymbals Café' },
  { guid: 'e0e79364-1913-4574-94de-729f56246d50', name: 'Nantucket IRD' },
  { guid: '7b99c87e-4281-45f0-b23c-a4195586aa6e', name: 'Zagara + Lobby' },
  { guid: '77a1ef88-657d-4f03-98ca-877ab424ce6b', name: 'Sag Pool' },
  { guid: '5ab33b37-9626-4a53-9a4b-e30e548dd203', name: 'Sag IRD' },
  { guid: 'ab8bb14f-d92a-48d7-9abb-b35910d4316e', name: 'Fortune Favors' },
  { guid: '482fcb30-d2df-4c92-b596-2f9708b707d5', name: 'Oyster Pool' },
  { guid: 'fe81d742-3b54-48cb-9f57-ff494bc3c9d4', name: 'Oyster IRD' },
];

function loadLocations(): Location[] {
  const raw = process.env.DASHBOARD_LOCATIONS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(l => l?.guid && l?.name)) return parsed;
    } catch { /* fall through */ }
    console.error('[dashboard] DASHBOARD_LOCATIONS is not valid JSON [{guid,name}]; using defaults');
  }
  return DEFAULT_LOCATIONS;
}

// ---------------------------------------------------------------- dates
const ymd = (d: Date) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
const toDate = (n: number) => new Date(Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100));
export const addDays = (n: number, k: number) => { const d = toDate(n); d.setUTCDate(d.getUTCDate() + k); return ymd(d); };
const parseStart = (s?: string) => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s || '');
  return m ? Number(m[1] + m[2] + m[3]) : 20260101;
};
/** Business date currently open at a location: local date, minus a day before the closeout hour. */
export function currentBusinessDate(now: Date, timeZone: string, closeoutHour: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(now).map(p => [p.type, p.value])
  );
  const local = Number(parts.year) * 10000 + Number(parts.month) * 100 + Number(parts.day);
  return Number(parts.hour) % 24 < (closeoutHour || 0) ? addDays(local, -1) : local;
}
function localMinutes(iso: string, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).map(p => [p.type, p.value])
  );
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

// ---------------------------------------------------------------- config
interface LocConfig {
  fetchedAt: string;
  tz: string;
  closeoutHour: number;
  firstBusinessDate?: number;
  schedules?: { daySchedules?: Record<string, any>; weekSchedule?: Record<string, string> };
  rc: Record<string, string>;
  area: Record<string, string>;
  service: Record<string, string>;
  cat: Record<string, string>;
  group: Record<string, string>;
  sources: Record<string, string>; // where each name map came from, or the error
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const hm = (s?: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

/** Daypart from the order's restaurant service, else from the location's schedule. */
export function daypartFor(order: any, cfg: Pick<LocConfig, 'service' | 'schedules' | 'tz'>, businessDate: number): string {
  const g = order?.restaurantService?.guid;
  if (g && cfg.service?.[g]) return cfg.service[g];
  const iso = order?.openedDate || order?.createdDate;
  const sched = cfg.schedules;
  if (iso && sched?.weekSchedule && sched?.daySchedules) {
    const day = sched.daySchedules[sched.weekSchedule[WEEKDAYS[toDate(businessDate).getUTCDay()]]];
    const m = localMinutes(iso, cfg.tz);
    for (const s of day?.services || []) {
      const a = hm(s?.hours?.startTime), b = hm(s?.hours?.endTime);
      if (isNaN(a) || isNaN(b)) continue;
      const hit = b > a ? m >= a && m < b : m >= a || m < b;
      if (hit) return s.name;
    }
  }
  return 'Unassigned';
}

// ---------------------------------------------------------------- aggregation
const NON_SALES = new Set(['TOAST_CARD_SELL', 'TOAST_CARD_RELOAD', 'HOUSE_ACCOUNT_PAY_BALANCE']);
const isNonSales = (s: any) => !s?.voided && NON_SALES.has(s?.selectionType);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface DayAgg {
  t: Record<string, number>;
  seg: Record<string, number[]>;   // rc|area|daypart -> [net, guests, checks, orders]
  cat: Record<string, number[]>;   // rc|area|daypart|category -> [net, qty]
  hrs: Record<string, number[]>;   // hour|rc -> [net, guests, checks]
  items: Record<string, number[]>; // rc|area|daypart|category|group|name -> [qty, net, gross]
}

export function aggregateDay(orders: any[], cfg: Pick<LocConfig, 'service' | 'schedules' | 'tz'>, businessDate: number): DayAgg {
  const t: Record<string, number> = {
    net: 0, gross: 0, disc: 0, tax: 0, tips: 0, svc: 0, grat: 0, gift: 0,
    del: 0, delN: 0, voids: 0, refunds: 0, guests: 0, checks: 0, orders: 0,
  };
  const seg: DayAgg['seg'] = {}, cat: DayAgg['cat'] = {}, hrs: DayAgg['hrs'] = {}, items: DayAgg['items'] = {};
  const bump = (m: Record<string, number[]>, k: string, ...v: number[]) => {
    const a = (m[k] ??= v.map(() => 0));
    v.forEach((x, i) => { a[i] += x; });
  };

  for (const o of orders || []) {
    const checksAll: any[] = o?.checks || [];
    if (o?.deleted) { checksAll.forEach(c => { t.delN++; t.del += c?.amount || 0; }); continue; }
    if (o?.voided) { checksAll.forEach(c => { t.voids += c?.totalAmount || 0; }); continue; }
    const live = checksAll.filter(c => {
      if (c?.deleted) { t.delN++; t.del += c?.amount || 0; return false; }
      if (c?.voided) { t.voids += c?.totalAmount || 0; return false; }
      return true;
    });
    if (!live.length) continue;

    const rc = o?.revenueCenter?.guid || '';
    const ar = o?.serviceArea?.guid || '';
    const dp = daypartFor(o, cfg, businessDate);
    const iso = o?.openedDate || o?.createdDate;
    const h = iso ? localHour(iso, cfg.tz) : 0;
    const guests = o?.numberOfGuests || 0;
    const sk = `${rc}|${ar}|${dp}`;
    let orderNet = 0;

    t.orders++;
    t.guests += guests;
    for (const c of live) {
      const sels: any[] = (c?.selections || []).filter((s: any) => !s?.voided);
      const gift = sels.filter(isNonSales).reduce((s, x) => s + (x?.price || 0), 0);
      const net = (c?.amount || 0) - gift;
      const svc = (c?.appliedServiceCharges || []).filter((x: any) => !x?.gratuity).reduce((s: number, x: any) => s + (x?.chargeAmount || 0), 0);
      const grat = (c?.appliedServiceCharges || []).filter((x: any) => x?.gratuity).reduce((s: number, x: any) => s + (x?.chargeAmount || 0), 0);
      t.checks++;
      t.net += net; t.gift += gift; t.svc += svc; t.grat += grat;
      t.tax += c?.taxAmount || 0;
      orderNet += net;
      (c?.payments || []).forEach((p: any) => {
        t.tips += p?.tipAmount || 0;
        if (p?.refund) t.refunds += p.refund.refundAmount || 0;
      });

      const seen = new Set<string>();
      const disc = (d: any) => {
        if (!d) return;
        if (d.guid) { if (seen.has(d.guid)) return; seen.add(d.guid); }
        t.disc += d.discountAmount || 0;
      };
      (c?.appliedDiscounts || []).forEach(disc);
      sels.forEach(s => (s?.appliedDiscounts || []).forEach(disc));

      let itemNet = 0;
      for (const s of sels) {
        if (isNonSales(s)) continue;
        const ct = s?.salesCategory?.guid || '';
        const gp = s?.itemGroup?.guid || '';
        const name = String(s?.displayName || 'Unnamed item').trim();
        const price = s?.price || 0;
        const qty = s?.quantity || 0;
        itemNet += price;
        bump(cat, `${sk}|${ct}`, price, qty);
        bump(items, `${sk}|${ct}|${gp}|${name}`, qty, price, s?.preDiscountPrice ?? price);
      }
      if (svc) bump(cat, `${sk}|__svc`, svc, 0);
      const adj = net - itemNet - svc;
      if (Math.abs(adj) >= 0.005) bump(cat, `${sk}|__adj`, adj, 0);
      bump(hrs, `${h}|${rc}`, net, 0, 1);
    }
    bump(seg, sk, orderNet, guests, live.length, 1);
    bump(hrs, `${h}|${rc}`, 0, guests, 0);
  }
  t.gross = t.net + t.disc;
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  const round = (m: Record<string, number[]>) => { for (const k in m) m[k] = m[k].map(r2); };
  [seg, cat, hrs, items].forEach(round);
  return { t, seg, cat, hrs, items };
}

// ---------------------------------------------------------------- the sync engine
interface DayRec { d: number; at: string; final: boolean; agg: Omit<DayAgg, 'items'> }
type Job = { guid: string; d: number; final: boolean; why: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class DashboardSync {
  readonly locations: Location[];
  readonly start: number;
  readonly refreshHours: number;
  readonly dir: string;
  private client: ToastClient;
  private cfg = new Map<string, LocConfig>();
  private days = new Map<string, Map<number, DayRec>>();
  private urgent: Job[] = [];
  private backfill: Job[] = [];
  private queued = new Set<string>();
  private running = false;
  private lastCall = 0;
  private summary?: { json: Buffer; gz: Buffer; etag: string; obj: any };
  private months = new Map<string, { json: Buffer; gz: Buffer; etag: string; obj: any }>();
  private dirtyMonths = new Set<string>();
  private dirty = true;
  readonly state = {
    startedAt: new Date().toISOString(),
    lastCycle: '' as string,
    nextCycle: '' as string,
    fetched: 0,
    failed: 0,
    requests: 0,
    backfillTotal: 0,
    current: '' as string,
    errors: [] as { at: string; where: string; message: string }[],
  };

  constructor(client: ToastClient, opts?: { dir?: string; locations?: Location[]; start?: string; refreshHours?: number }) {
    this.client = client;
    this.locations = opts?.locations || loadLocations();
    this.start = parseStart(opts?.start || process.env.DASHBOARD_START);
    this.refreshHours = opts?.refreshHours || Number(process.env.DASHBOARD_REFRESH_HOURS) || 4;
    this.dir = opts?.dir || process.env.DATA_DIR || '/data';
    try {
      fs.mkdirSync(path.join(this.dir, 'days'), { recursive: true });
      fs.accessSync(this.dir, fs.constants.W_OK);
    } catch {
      this.dir = path.resolve('data');
      fs.mkdirSync(path.join(this.dir, 'days'), { recursive: true });
      this.err('storage', `DATA_DIR not writable; using ${this.dir} (not persistent across deploys)`);
    }
    fs.mkdirSync(path.join(this.dir, 'config'), { recursive: true });
    this.loadFromDisk();
  }

  private err(where: string, e: any) {
    const message = typeof e === 'string' ? e : (e?.message || JSON.stringify(e)).slice(0, 300);
    this.state.errors.unshift({ at: new Date().toISOString(), where, message });
    this.state.errors.length = Math.min(this.state.errors.length, 40);
    console.error(`[dashboard] ${where}: ${message}`);
  }

  // ------------------------------------------------ disk
  private dayPath(guid: string, d: number) { return path.join(this.dir, 'days', guid, `${d}.json`); }
  private writeJson(file: string, data: any) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  private loadFromDisk() {
    for (const loc of this.locations) {
      const m = new Map<number, DayRec>();
      this.days.set(loc.guid, m);
      const cfgFile = path.join(this.dir, 'config', `${loc.guid}.json`);
      try { this.cfg.set(loc.guid, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch { /* fetched later */ }
      const dir = path.join(this.dir, 'days', loc.guid);
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter(f => /^\d{8}\.json$/.test(f)); } catch { continue; }
      for (const f of files) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const { items, ...light } = rec.agg || {};
          m.set(rec.d, { d: rec.d, at: rec.at, final: !!rec.final, agg: light });
        } catch (e) { this.err(`load ${loc.name} ${f}`, e); }
      }
    }
  }

  // ------------------------------------------------ Toast calls
  private async call<T>(fn: () => Promise<T>, where: string): Promise<T> {
    let wait = 1500;
    for (let attempt = 0; ; attempt++) {
      const gap = 250 - (Date.now() - this.lastCall);
      if (gap > 0) await sleep(gap);
      this.lastCall = Date.now();
      this.state.requests++;
      try {
        return await fn();
      } catch (e: any) {
        const retryable = e?.status === 429 || (e?.status >= 500) || e?.code === 'NO_RESPONSE';
        if (!retryable || attempt >= 6) throw e;
        await sleep(wait);
        wait = Math.min(wait * 2, 30000);
        void where;
      }
    }
  }
  private async configList(guid: string, endpoint: string): Promise<any[]> {
    const ax = (this.client as any).axiosInstance;
    const out: any[] = [];
    let token: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res: any = await this.call(
        () => ax.get(endpoint, { params: token ? { pageToken: token } : {}, headers: { 'Toast-Restaurant-External-ID': guid } }),
        endpoint
      );
      const data = res?.data;
      if (Array.isArray(data)) out.push(...data);
      token = res?.headers?.['toast-next-page-token'] || undefined;
      if (!token) break;
    }
    return out;
  }
  async loadConfig(loc: Location, force = false): Promise<LocConfig> {
    const have = this.cfg.get(loc.guid);
    if (have && !force && Date.now() - Date.parse(have.fetchedAt) < 24 * 3600e3) return have;
    const cfg: LocConfig = {
      fetchedAt: new Date().toISOString(), tz: have?.tz || 'America/New_York', closeoutHour: have?.closeoutHour ?? 4,
      firstBusinessDate: have?.firstBusinessDate, schedules: have?.schedules,
      rc: { ...(have?.rc || {}) }, area: { ...(have?.area || {}) }, service: { ...(have?.service || {}) },
      cat: { ...(have?.cat || {}) }, group: { ...(have?.group || {}) }, sources: {},
    };
    try {
      const info: any = await this.call(() => this.client.get(`/restaurants/v1/restaurants/${loc.guid}`, { restaurantGuid: loc.guid }), 'restaurant');
      const g = info?.general || {};
      cfg.tz = g.timeZone || cfg.tz;
      cfg.closeoutHour = typeof g.closeoutHour === 'number' ? g.closeoutHour : cfg.closeoutHour;
      cfg.firstBusinessDate = g.firstBusinessDate || cfg.firstBusinessDate;
      cfg.schedules = info?.schedules || cfg.schedules;
      cfg.sources.restaurant = 'ok';
    } catch (e: any) { cfg.sources.restaurant = `error: ${e?.message || e}`; this.err(`config ${loc.name} restaurant`, e); }
    const lists: [keyof LocConfig, string][] = [
      ['rc', '/config/v2/revenueCenters'], ['area', '/config/v2/serviceAreas'],
      ['service', '/config/v2/restaurantServices'], ['cat', '/config/v2/salesCategories'],
      ['group', '/config/v2/menuGroups'],
    ];
    for (const [key, ep] of lists) {
      try {
        const rows = await this.configList(loc.guid, ep);
        rows.forEach(r => { if (r?.guid && r?.name) (cfg[key] as Record<string, string>)[r.guid] = r.name; });
        cfg.sources[key as string] = `config api (${rows.length})`;
      } catch (e: any) { cfg.sources[key as string] = `error: ${e?.message || e}`; }
    }
    try {
      const menus = await this.call(() => fetchMenus(this.client, loc.guid), 'menus');
      let n = 0;
      for (const menu of menus) {
        for (const grp of allGroups(menu)) {
          if (grp.guid && grp.name && !cfg.group[grp.guid]) { cfg.group[grp.guid] = grp.name; n++; }
          for (const it of menuItemsOf(grp) as any[]) {
            const sc = it?.salesCategory;
            if (sc?.guid && sc?.name && !cfg.cat[sc.guid]) { cfg.cat[sc.guid] = sc.name; n++; }
          }
        }
      }
      cfg.sources.menus = `ok (+${n} names)`;
    } catch (e: any) { cfg.sources.menus = `error: ${e?.message || e}`; }
    this.cfg.set(loc.guid, cfg);
    this.writeJson(path.join(this.dir, 'config', `${loc.guid}.json`), cfg);
    console.error(`[dashboard] names ${loc.name}: ${Object.entries(cfg.sources).map(([k, v]) => `${k} ${v}`).join('; ')}`);
    this.dirty = true;
    return cfg;
  }

  private async fetchOrders(guid: string, d: number): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.call(
        () => this.client.get<any[]>('/orders/v2/ordersBulk', { restaurantGuid: guid, businessDate: d, page, pageSize: 100 }),
        'ordersBulk'
      );
      if (!Array.isArray(rows)) break;
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }

  async pullDay(loc: Location, d: number, final: boolean) {
    const cfg = await this.loadConfig(loc);
    const orders = await this.fetchOrders(loc.guid, d);
    const agg = aggregateDay(orders, cfg, d);
    const rec = { d, g: loc.guid, at: new Date().toISOString(), final, agg };
    this.writeJson(this.dayPath(loc.guid, d), rec);
    const { items, ...light } = agg;
    this.days.get(loc.guid)!.set(d, { d, at: rec.at, final, agg: light });
    this.dirty = true;
    this.dirtyMonths.add(String(d).slice(0, 6));
    this.state.fetched++;
  }

  // ------------------------------------------------ scheduling
  private enqueue(list: Job[], job: Job) {
    const key = `${job.guid}|${job.d}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    list.push(job);
  }
  async planCycle() {
    const now = new Date();
    for (const loc of this.locations) {
      let cfg: LocConfig;
      try { cfg = await this.loadConfig(loc); } catch (e) { this.err(`config ${loc.name}`, e); continue; }
      const cur = currentBusinessDate(now, cfg.tz, cfg.closeoutHour);
      const first = Math.max(this.start, cfg.firstBusinessDate || 0);
      const have = this.days.get(loc.guid)!;
      this.enqueue(this.urgent, { guid: loc.guid, d: cur, final: false, why: 'current' });
      for (const [d, rec] of have) {
        if (d < cur && !rec.final) this.enqueue(this.urgent, { guid: loc.guid, d, final: true, why: 'final after closeout' });
      }
      for (let d = addDays(cur, -1); d >= first; d = addDays(d, -1)) {
        if (!have.has(d)) this.enqueue(this.backfill, { guid: loc.guid, d, final: true, why: 'backfill' });
      }
    }
    // newest first across locations, so recent months fill in first
    this.backfill.sort((a, b) => b.d - a.d);
    this.state.backfillTotal = Math.max(this.state.backfillTotal, this.backfill.length);
    this.state.lastCycle = now.toISOString();
    this.state.nextCycle = new Date(now.getTime() + this.refreshHours * 3600e3).toISOString();
  }
  requestRefresh(from: number, to: number, guids?: string[]) {
    let n = 0;
    for (const loc of this.locations) {
      if (guids?.length && !guids.includes(loc.guid) && !guids.includes(loc.name)) continue;
      const cfg = this.cfg.get(loc.guid);
      const cur = cfg ? currentBusinessDate(new Date(), cfg.tz, cfg.closeoutHour) : 99999999;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const key = `${loc.guid}|${d}`;
        this.queued.delete(key);
        this.enqueue(this.urgent, { guid: loc.guid, d, final: d < cur, why: 'manual' });
        n++;
      }
    }
    void this.work();
    return n;
  }
  async work() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.urgent.shift() || this.backfill.shift();
        if (!job) break;
        this.queued.delete(`${job.guid}|${job.d}`);
        const loc = this.locations.find(l => l.guid === job.guid)!;
        this.state.current = `${loc.name} ${job.d} (${job.why})`;
        try { await this.pullDay(loc, job.d, job.final); }
        catch (e) { this.state.failed++; this.err(`pull ${loc.name} ${job.d}`, e); }
        if ((this.state.fetched + this.state.failed) % 100 === 0 || (!this.urgent.length && !this.backfill.length)) {
          console.error(`[dashboard] progress: ${this.state.fetched} pulled, ${this.state.failed} failed, ${this.urgent.length} urgent + ${this.backfill.length} backfill left; ${this.state.requests} Toast calls; last ${loc.name} ${job.d}`);
        }
      }
    } finally {
      this.running = false;
      this.state.current = '';
    }
    this.logReport();
  }
  /** One log line per location after the queue drains: name sources, names, monthly net/guests. */
  logReport() {
    for (const loc of this.locations) {
      const c = this.cfg.get(loc.guid);
      const months: Record<string, [number, number]> = {};
      for (const r of this.days.get(loc.guid)!.values()) {
        const k = String(r.d).slice(0, 6);
        const m = (months[k] ??= [0, 0]);
        m[0] = r2(m[0] + r.agg.t.net); m[1] += r.agg.t.guests;
      }
      console.error(`[dashboard] report ${JSON.stringify({ loc: loc.name, sources: c?.sources, rc: c?.rc, area: c?.area, service: c?.service, cats: Object.values(c?.cat || {}), months })}`);
    }
  }
  begin() {
    const cycle = async () => {
      try { await this.planCycle(); } catch (e) { this.err('plan', e); }
      void this.work();
    };
    setTimeout(cycle, 5000);
    setInterval(cycle, this.refreshHours * 3600e3);
  }

  // ------------------------------------------------ output
  private labels(guid: string) {
    const c = this.cfg.get(guid);
    const rc = (g: string) => (g ? c?.rc[g] || `RC ${g.slice(0, 6)}` : 'No revenue center');
    const ar = (g: string) => (g ? c?.area[g] || `Area ${g.slice(0, 6)}` : 'No area');
    const cat = (g: string) => g === '__svc' ? 'Service charges' : g === '__adj' ? 'Other adjustments' : (g ? c?.cat[g] || `Category ${g.slice(0, 6)}` : 'No category');
    const grp = (g: string) => (g ? c?.group[g] || 'Other' : 'Other');
    return { rc, ar, cat, grp };
  }
  private pack(obj: any) {
    const json = Buffer.from(JSON.stringify(obj));
    return { json, gz: zlib.gzipSync(json), etag: `"${Date.now().toString(36)}-${json.length.toString(36)}"`, obj };
  }
  /**
   * The same data as /dashboard/data.json and /dashboard/items/YYYYMM.json, in pieces small
   * enough for an MCP tool result (used by the dashboard when it runs inside Claude).
   *  part "meta": everything but the row arrays, plus the months available and the build etag.
   *  part "summary" + month: that month's days/seg/cat/hrs rows (indexes into meta.dict).
   *  part "items" + month + page: item rows for the month, ITEM_PAGE rows per page, with that month's dict.
   */
  dataPart(input: { part: string; month?: string; page?: number }) {
    const S = this.buildSummary();
    const o = S.obj;
    if (input.part === 'meta') {
      const months = [...new Set((o.days as any[]).map(r => String(r[0]).slice(0, 6)))].sort();
      const { days, seg, cat, hrs, ...meta } = o;
      return { ...meta, etag: S.etag, months, rows: { days: days.length, seg: seg.length, cat: cat.length, hrs: hrs.length } };
    }
    const month = String(input.month || '');
    if (!/^\d{6}$/.test(month)) throw new Error('month must be YYYYMM');
    if (input.part === 'summary') {
      const m = Number(month);
      const pick = (rows: any[]) => rows.filter(r => Math.floor(r[0] / 100) === m);
      return { etag: S.etag, month, days: pick(o.days), seg: pick(o.seg), cat: pick(o.cat), hrs: pick(o.hrs) };
    }
    if (input.part === 'items') {
      const M = this.buildMonth(month);
      const ITEM_PAGE = 12000;
      const page = Math.max(0, Math.floor(input.page || 0));
      const rows = M.obj.rows as any[];
      return { etag: M.etag, month, page, pages: Math.max(1, Math.ceil(rows.length / ITEM_PAGE)), cols: M.obj.cols, dict: M.obj.dict, rows: rows.slice(page * ITEM_PAGE, (page + 1) * ITEM_PAGE) };
    }
    throw new Error('part must be meta, summary or items');
  }
  buildSummary() {
    if (this.summary && !this.dirty) return this.summary;
    const dict: Record<string, string[]> = { rc: [], ar: [], dp: [], cat: [] };
    const idx: Record<string, Map<string, number>> = { rc: new Map(), ar: new Map(), dp: new Map(), cat: new Map() };
    const id = (k: string, v: string) => { let i = idx[k].get(v); if (i === undefined) { i = dict[k].length; dict[k].push(v); idx[k].set(v, i); } return i; };
    const days: any[] = [], seg: any[] = [], cat: any[] = [], hrs: any[] = [];
    let through = 0;
    const locs = this.locations.map((loc, li) => {
      const L = this.labels(loc.guid);
      const c = this.cfg.get(loc.guid);
      const recs = [...(this.days.get(loc.guid)?.values() || [])].sort((a, b) => a.d - b.d);
      let finalThrough = 0, last = 0;
      for (const r of recs) {
        const t = r.agg.t;
        last = Math.max(last, r.d);
        if (r.final) finalThrough = Math.max(finalThrough, r.d);
        through = Math.max(through, r.d);
        days.push([r.d, li, t.net, t.gross, t.disc, t.tax, t.tips, t.svc, t.gift, t.guests, t.checks, t.orders, r.final ? 1 : 0, t.del, t.voids]);
        for (const [k, v] of Object.entries(r.agg.seg)) {
          const [rc, ar, dp] = k.split('|');
          seg.push([r.d, li, id('rc', L.rc(rc)), id('ar', L.ar(ar)), id('dp', dp), ...v.slice(0, 3)]);
        }
        for (const [k, v] of Object.entries(r.agg.cat)) {
          const [rc, ar, dp, ct] = k.split('|');
          cat.push([r.d, li, id('rc', L.rc(rc)), id('ar', L.ar(ar)), id('dp', dp), id('cat', L.cat(ct)), v[0], v[1]]);
        }
        for (const [k, v] of Object.entries(r.agg.hrs)) {
          const [h, rc] = k.split('|');
          hrs.push([r.d, li, id('rc', L.rc(rc)), Number(h), v[0], v[1], v[2]]);
        }
      }
      return {
        name: loc.name, guid: loc.guid, tz: c?.tz, closeoutHour: c?.closeoutHour,
        current: c ? currentBusinessDate(new Date(), c.tz, c.closeoutHour) : null,
        days: recs.length, last, finalThrough, lastPulled: recs.reduce((m, r) => (r.at > m ? r.at : m), ''),
      };
    });
    this.summary = this.pack({
      v: 1, generatedAt: new Date().toISOString(), start: this.start, through,
      refreshHours: this.refreshHours, lastCycle: this.state.lastCycle, nextCycle: this.state.nextCycle,
      backfillRemaining: this.backfill.length,
      cols: {
        days: ['d', 'loc', 'net', 'gross', 'disc', 'tax', 'tips', 'svc', 'gift', 'guests', 'checks', 'orders', 'final', 'deleted', 'voids'],
        seg: ['d', 'loc', 'rc', 'ar', 'dp', 'net', 'guests', 'checks'],
        cat: ['d', 'loc', 'rc', 'ar', 'dp', 'cat', 'net', 'qty'],
        hrs: ['d', 'loc', 'rc', 'hour', 'net', 'guests', 'checks'],
      },
      locations: locs, dict, days, seg, cat, hrs,
    });
    this.dirty = false;
    return this.summary;
  }
  buildMonth(month: string) {
    const cached = this.months.get(month);
    if (cached && !this.dirtyMonths.has(month)) return cached;
    const dict: Record<string, string[]> = { rc: [], ar: [], dp: [], cat: [], grp: [], item: [] };
    const idx: Record<string, Map<string, number>> = Object.fromEntries(Object.keys(dict).map(k => [k, new Map()]));
    const id = (k: string, v: string) => { let i = idx[k].get(v); if (i === undefined) { i = dict[k].length; dict[k].push(v); idx[k].set(v, i); } return i; };
    const rows: any[] = [];
    this.locations.forEach((loc, li) => {
      const L = this.labels(loc.guid);
      for (const d of this.days.get(loc.guid)?.keys() || []) {
        if (String(d).slice(0, 6) !== month) continue;
        let rec: any;
        try { rec = JSON.parse(fs.readFileSync(this.dayPath(loc.guid, d), 'utf8')); } catch { continue; }
        for (const [k, v] of Object.entries(rec.agg?.items || {}) as [string, number[]][]) {
          const [rc, ar, dp, ct, gp, ...name] = k.split('|');
          rows.push([d, li, id('rc', L.rc(rc)), id('ar', L.ar(ar)), id('dp', dp), id('cat', L.cat(ct)), id('grp', L.grp(gp)), id('item', name.join('|')), v[0], v[1], v[2]]);
        }
      }
    });
    const out = this.pack({ v: 1, month, cols: ['d', 'loc', 'rc', 'ar', 'dp', 'cat', 'grp', 'item', 'qty', 'net', 'gross'], dict, rows });
    this.months.set(month, out);
    this.dirtyMonths.delete(month);
    return out;
  }

  status(detail?: { months?: boolean; date?: number }) {
    const base: any = {
      ...this.state,
      storage: this.dir,
      start: this.start,
      refreshHours: this.refreshHours,
      running: this.running,
      queue: { urgent: this.urgent.length, backfill: this.backfill.length },
      locations: this.locations.map(loc => {
        const m = this.days.get(loc.guid)!;
        const ds = [...m.keys()].sort((a, b) => a - b);
        const c = this.cfg.get(loc.guid);
        return {
          name: loc.name, guid: loc.guid, stored: ds.length, first: ds[0] || null, last: ds[ds.length - 1] || null,
          partial: ds.filter(d => !m.get(d)!.final),
          tz: c?.tz, closeoutHour: c?.closeoutHour, firstBusinessDate: c?.firstBusinessDate, names: c?.sources,
        };
      }),
    };
    if (detail?.months) {
      base.months = this.locations.map(loc => {
        const out: Record<string, { net: number; guests: number; checks: number; days: number }> = {};
        for (const r of this.days.get(loc.guid)!.values()) {
          const k = String(r.d).slice(0, 6);
          const o = (out[k] ??= { net: 0, guests: 0, checks: 0, days: 0 });
          o.net = r2(o.net + r.agg.t.net); o.guests += r.agg.t.guests; o.checks += r.agg.t.checks;
          if (r.agg.t.net || r.agg.t.checks) o.days++;
        }
        return { name: loc.name, months: out };
      });
    }
    if (detail?.date) {
      base.date = this.locations.map(loc => {
        const r = this.days.get(loc.guid)!.get(detail.date!);
        if (!r) return { name: loc.name, stored: false };
        const L = this.labels(loc.guid);
        const byRc: Record<string, number> = {};
        for (const [k, v] of Object.entries(r.agg.seg)) { const n = L.rc(k.split('|')[0]); byRc[n] = r2((byRc[n] || 0) + v[0]); }
        const byCat: Record<string, number> = {};
        for (const [k, v] of Object.entries(r.agg.cat)) { const n = L.cat(k.split('|')[3]); byCat[n] = r2((byCat[n] || 0) + v[0]); }
        return { name: loc.name, at: r.at, final: r.final, totals: r.agg.t, byRevenueCenter: byRc, byCategory: byCat };
      });
    }
    return base;
  }
}

// ---------------------------------------------------------------- singleton, HTTP, MCP tools
let engine: DashboardSync | undefined;
export const getDashboardSync = () => engine;

export function startDashboardSync(client: ToastClient): DashboardSync | undefined {
  if (engine) return engine;
  if ((process.env.DASHBOARD_SYNC || 'on').toLowerCase() === 'off') return undefined;
  engine = new DashboardSync(client);
  engine.begin();
  console.error(`[dashboard] sync on: ${engine.locations.length} locations from ${engine.start}, every ${engine.refreshHours}h, storage ${engine.dir}`);
  return engine;
}

/** Mounts GET /dashboard/data.json, /dashboard/items/YYYYMM.json and /dashboard/status on an express app. */
export function mountDashboardRoutes(app: any) {
  const cors = (res: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'x-dashboard-key, if-none-match');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
  };
  const authed = (req: any, res: any) => {
    cors(res);
    const key = process.env.DASHBOARD_KEY;
    if (!engine) { res.status(503).json({ error: 'dashboard sync is not running' }); return false; }
    if (!key || key.length < 16) { res.status(503).json({ error: 'DASHBOARD_KEY is not set' }); return false; }
    const given = req.query?.key || req.headers['x-dashboard-key'];
    if (given !== key) { res.status(401).json({ error: 'unauthorized' }); return false; }
    return true;
  };
  const send = (req: any, res: any, out: { json: Buffer; gz: Buffer; etag: string }) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', out.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === out.etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(out.gz);
    } else res.end(out.json);
  };
  app.options('/dashboard/*', (_req: any, res: any) => { cors(res); res.status(204).end(); });
  app.get('/dashboard/data.json', (req: any, res: any) => {
    if (!authed(req, res)) return;
    try { send(req, res, engine!.buildSummary()); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/dashboard/items/:month.json', (req: any, res: any) => {
    if (!authed(req, res)) return;
    const month = String(req.params.month || '');
    if (!/^\d{6}$/.test(month)) { res.status(400).json({ error: 'month must be YYYYMM' }); return; }
    try { send(req, res, engine!.buildMonth(month)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  // The dashboard page itself, built into the repo at dashboard/index.html. Same key as the data.
  const pageFile = path.resolve(process.env.DASHBOARD_PAGE || 'dashboard/index.html');
  const page = (req: any, res: any) => {
    const key = process.env.DASHBOARD_KEY;
    if (!key || key.length < 16) { res.status(503).send('DASHBOARD_KEY is not set'); return; }
    if ((req.query?.key || '') !== key) { res.status(401).type('text/plain').send('Add ?key=… to the address to open the dashboard.'); return; }
    let st: fs.Stats;
    try { st = fs.statSync(pageFile); } catch { res.status(404).type('text/plain').send('The dashboard page is not deployed yet.'); return; }
    const etag = `"p${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('X-Robots-Tag', 'noindex');
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const buf = fs.readFileSync(pageFile);
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding'); res.end(zlib.gzipSync(buf)); }
    else res.end(buf);
  };
  app.get('/dashboard/', page);
  app.get('/dashboard', (req: any, res: any) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(302, '/dashboard/' + q);
  });
  app.get('/dashboard/status', (_req: any, res: any) => {
    cors(res);
    if (!engine) { res.status(503).json({ running: false }); return; }
    const s = engine.status();
    res.json({
      running: s.running, lastCycle: s.lastCycle, nextCycle: s.nextCycle, queue: s.queue, fetched: s.fetched, failed: s.failed,
      locations: s.locations.map((l: any) => ({ name: l.name, stored: l.stored, first: l.first, last: l.last })),
    });
  });
}

export function registerDashboardTools(_client: ToastClient) {
  return [
    {
      name: 'toast_dashboard_status',
      description: 'Status of the F&B dashboard sync: backfill progress, last/next refresh, errors, stored days per location. Optional: months=true for monthly net/guests/checks per location, or date=YYYYMMDD for that day per location by revenue center and sales category.',
      inputSchema: z.object({
        months: z.boolean().optional(),
        date: z.number().optional().describe('Business date YYYYMMDD'),
      }),
      handler: async (args: { months?: boolean; date?: number }) => {
        if (!engine) return { running: false, message: 'Dashboard sync runs only in http mode with DASHBOARD_SYNC not set to off.' };
        return engine.status(args);
      },
    },
    {
      name: 'toast_dashboard_data',
      compact: true,
      description: 'Data for the F&B Sales dashboard, in pieces. part="meta" first (locations, names, months, etag), then part="summary" with month=YYYYMM for each month, and part="items" with month and page (0..pages-1) for item sales. Read-only.',
      inputSchema: z.object({
        part: z.string().describe('meta | summary | items'),
        month: z.string().optional().describe('YYYYMM (summary, items)'),
        page: z.number().optional().describe('items page, from 0'),
      }),
      handler: async (args: { part: string; month?: string; page?: number }) => {
        if (!engine) return { error: 'dashboard sync is not running' };
        return engine.dataPart(args);
      },
    },
    {
      name: 'toast_dashboard_refresh',
      description: 'Re-pull business dates into the F&B dashboard store (e.g. after a check was edited). Dates are YYYYMMDD. Optional locations: names or GUIDs.',
      inputSchema: z.object({
        from: z.number().describe('First business date YYYYMMDD'),
        to: z.number().optional().describe('Last business date YYYYMMDD (default = from)'),
        locations: z.array(z.string()).optional(),
        reloadNames: z.boolean().optional().describe('Also re-read revenue center, area, daypart and category names'),
      }),
      handler: async (args: { from: number; to?: number; locations?: string[]; reloadNames?: boolean }) => {
        if (!engine) return { running: false };
        const to = args.to || args.from;
        if (to < args.from || addDays(args.from, 400) < to) return { error: 'to must be on or after from, within 400 days' };
        if (args.reloadNames) {
          for (const loc of engine.locations) {
            if (args.locations?.length && !args.locations.includes(loc.name) && !args.locations.includes(loc.guid)) continue;
            try { await engine.loadConfig(loc, true); } catch { /* recorded in status */ }
          }
        }
        const queued = engine.requestRefresh(args.from, to, args.locations);
        return { queued, message: `Queued ${queued} location-days ahead of any backfill.` };
      },
    },
  ];
}
