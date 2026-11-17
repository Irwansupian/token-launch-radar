// Launch Radar model: one sealed DefiLlama snapshot in, one ranked board of pre-token protocols out.
//
// The question the board answers: if this protocol issued a token today, what would the launch be
// worth? The answer is built only from the snapshot's own figures, in four steps:
//
//   1. Calibrate. Every protocol whose token already trades gives a market observation,
//      ratio = mcap / TVL. Ratios are winsorized to [0.02, 5] so one meme outlier cannot bend the
//      scale, and each category's multiple is the median of its winsorized ratios shrunk toward
//      the global median with a pseudo-count of 5, then clamped to [0.05, 3]: the median, not the
//      mean, because a handful of richly valued tokens would otherwise drag a whole category's
//      multiple away from where its typical token trades. A category the market has priced many
//      times speaks for itself; a thin one borrows the market's overall verdict.
//   2. Base. base = TVL x the protocol's category multiple. A lending market is priced like the
//      lending tokens that already trade, not like a DEX or a bridge.
//   3. Momentum. Seven-day TVL growth tilts the base: factor = 1 + clamp(change_7d, -50, 100)% x 0.5.
//      A protocol adding TVL into a launch is worth more than one leaking it; unreported is neutral.
//   4. Maturity. A protocol that has run longer with no token has more proof behind it:
//      factor = 0.7 + 0.3 x min(age_days, 1460) / 1460, with 0.85 when DefiLlama gives no date.
//
//   implied_value_usd = round(TVL x multiple x momentum x maturity), at least 1.
//
// The board always carries every watchlist slug (the floor), plus every other protocol that
// records no token and is not a wrapped, staked or bridged product of one that trades: the extra
// exclusions for non-watchlist rows are the categories Liquid Staking, Liquid Restaking,
// Restaked BTC, Bridge, Canonical Bridge, CEX, Stablecoin Wrapper and Anchor BTC (the two bridge
// categories are where DefiLlama files wrapped-asset products such as bridged BTC and bridged
// stablecoins, which is why the house's watchlist rule leaves them out too), version-marker names,
// names carrying the whole word wrapped, staked or staking, and names opening with an exchange's
// name. Tokenized protocols never enter the ranking; the dashboard shows them apart, at the
// market's own values, as the calibration set. No protocol name is special-cased anywhere: one
// function scores every row, and the dashboard recomputes each row from the same figures.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard's method panel so a reader can audit them. */
export const MODEL = {
  version: 'launch-radar-2',
  winsor_low: 0.02,
  winsor_high: 5,
  shrink_k: 5,
  multiple_low: 0.05,
  multiple_high: 3,
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 100,
  maturity_base: 0.7,
  maturity_range: 0.3,
  maturity_days: 1460,
  unknown_age_factor: 0.85,
};

/** One category's calibration: how many trading tokens priced it, and the multiple the board uses. */
export interface Calibration {
  category: string;
  n: number;
  median_ratio: number | null;
  multiple: number;
}

/** One row of board.json: the ranked board's row, with the model's own arithmetic attached. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    calibration_n: number;
    momentum_factor: number;
    maturity_factor: number;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: the row itself, farm plan included. */
export interface RadarRow extends BoardRow {}

/** A tokenized protocol, shown apart at the market's own value: the calibration set, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  global_median_ratio: number;
  calibration: Calibration[];
  counts: {
    protocols: number;
    tokenized: number;
    pre_token: number;
    board: number;
    watchlist: number;
    early: number;
    excluded_products: number;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from listed_at to the snapshot's as_of, clamped at zero; null when undated. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether DefiLlama's record carries a token for the protocol (any of the three token fields). */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_HEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const PRODUCT_CATEGORIES = new Set([
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Bridge',
  'Canonical Bridge',
  'CEX',
  'Stablecoin Wrapper',
  'Anchor BTC',
]);

/**
 * Whether a pre-token protocol is a wrapped, staked or bridged product of a token that already
 * trades, judged from the snapshot's own fields. The watchlist is exempt: the house already kept
 * those, and the board covers every one of them whatever this says.
 */
export function isProductOfTraded(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (PRODUCT_WORD.test(p.name)) return true;
  if (EXCHANGE_HEAD.test(p.name)) return true;
  return false;
}

/** The median of a non-empty sorted array. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The calibration table: one entry per category that appears among pre-token candidates or the
 * tokenized set, with the multiple the board uses for it. Derived only from tokenized protocols
 * with both a market cap and a TVL.
 */
export function calibrate(snapshot: Snapshot): { globalMedian: number; table: Map<string, Calibration>; globalMultiple: number } {
  const winsor = (r: number): number => clamp(r, MODEL.winsor_low, MODEL.winsor_high);
  const all: number[] = [];
  const byCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const r = winsor(p.mcap_usd / p.tvl_usd);
    all.push(r);
    const key = p.category ?? 'Uncategorized';
    const list = byCategory.get(key);
    if (list) list.push(r);
    else byCategory.set(key, [r]);
  }
  all.sort((a, b) => a - b);
  const globalMedian = all.length > 0 ? median(all) : 0.25;
  const globalMultiple = clamp(globalMedian, MODEL.multiple_low, MODEL.multiple_high);
  const table = new Map<string, Calibration>();
  const categories = new Set<string>();
  for (const p of snapshot.protocols) categories.add(p.category ?? 'Uncategorized');
  for (const category of [...categories].sort()) {
    const list = (byCategory.get(category) ?? []).slice().sort((a, b) => a - b);
    const n = list.length;
    const shrunk = n === 0 ? globalMedian : (n * median(list) + MODEL.shrink_k * globalMedian) / (n + MODEL.shrink_k);
    table.set(category, {
      category,
      n,
      median_ratio: n > 0 ? round4(median(list)) : null,
      multiple: round4(clamp(shrunk, MODEL.multiple_low, MODEL.multiple_high)),
    });
  }
  return { globalMedian: round4(globalMedian), table, globalMultiple: round4(globalMultiple) };
}

/** The three factors and the implied value one protocol gets. One function scores every row. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  cal: { table: Map<string, Calibration>; globalMultiple: number },
): { implied: number; multiple: number; calibrationN: number; momentum: number; maturity: number; age: number | null } {
  const entry = cal.table.get(p.category ?? 'Uncategorized');
  const multiple = entry ? entry.multiple : cal.globalMultiple;
  const calibrationN = entry ? entry.n : 0;
  const growth = p.change_7d === null ? 0 : clamp(p.change_7d, MODEL.growth_floor, MODEL.growth_cap);
  const momentum = 1 + (growth / 100) * MODEL.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const maturity =
    age === null
      ? MODEL.unknown_age_factor
      : MODEL.maturity_base + (Math.min(age, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity));
  return { implied, multiple, calibrationN, momentum: round4(momentum), maturity: round4(maturity), age };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Gas money for one transaction on the protocol's first chain, in whole dollars. */
function gasFor(p: SnapshotProtocol): number {
  const c = chainOf(p);
  if (c === 'Ethereum') return 9;
  if (c === 'Bitcoin') return 4;
  return 2;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action and its weekly qualifying action, in words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): { core: string; weekly: string } {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('bridge'))
    return {
      core: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then bridge a smaller amount back a week later so both directions count`,
      weekly: `bridge one transfer of $25 or more through ${n} each week, alternating the direction`,
    };
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return {
      core: `Supply $${capital} of USDC as collateral in ${n} on ${chain} and borrow no more than 40% against it, so the position survives a bad week`,
      weekly: `adjust the position once a week: top the collateral up or repay a slice, and claim any rewards the market shows`,
    };
  if (c.includes('dex'))
    return {
      core: `Provide $${capital} of liquidity to ${n}'s busiest USDC pair on ${chain} and make two swaps of $25 or more through the same pool`,
      weekly: `swap at least $25 through ${n} each week and re-centre the liquidity position if the price has drifted`,
    };
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option'))
    return {
      core: `Deposit $${capital} of USDC as margin on ${n} and open one small hedged trade, long and short the same notional, so volume counts without directional risk`,
      weekly: `roll the hedge once a week and keep the margin ratio above 200% at all times`,
    };
  if (c.includes('curator') || c.includes('allocator') || c.includes('collateral management'))
    return {
      core: `Deposit $${capital} of USDC into one of ${n}'s curated vaults on ${chain} and keep the vault shares in the same wallet`,
      weekly: `check the vault's allocation once a week and add $25 whenever the curator rebalances into a new market`,
    };
  if (c.includes('basis'))
    return {
      core: `Open ${n}'s standard basis position with $${capital}: the spot leg and the funding leg together, exactly as its interface pairs them`,
      weekly: `confirm both legs are still open once a week and top the margin up if funding moves against the position`,
    };
  if (c.includes('rwa'))
    return {
      core: `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it in the farming wallet`,
      weekly: `hold the asset and make one small additional mint of $25 each week to keep the wallet active`,
    };
  if (c.includes('launchpad'))
    return {
      core: `Register the farming wallet on ${n}, complete its participation steps and take part in one sale or waitlist with $${capital} ready`,
      weekly: `check ${n}'s upcoming sales once a week and join each new waitlist the day it opens`,
    };
  if (c.includes('prediction'))
    return {
      core: `Fund ${n} with $${capital} and take positions in three different markets, favouring ones that settle within the month`,
      weekly: `trade at least one market a week and settle expired positions so the history shows completed trades`,
    };
  if (c.includes('privacy'))
    return {
      core: `Deposit $${capital} into ${n}'s shielded pool on ${chain} and make two private transfers between your own wallets`,
      weekly: `make one shielded transaction a week and keep the viewing records the app offers to export`,
    };
  if (c.includes('chain'))
    return {
      core: `Bridge $${capital} of USDC onto ${n} and use two of its native applications, one swap and one deposit, in the first session`,
      weekly: `transact on ${n} at least twice a week, spreading the activity across different native applications`,
    };
  if (c.includes('insurance'))
    return {
      core: `Buy $${capital} of cover from ${n} on ${chain} for a position you actually hold, and keep the policy for its full term`,
      weekly: `check the policy and the pool's capacity once a week, and renew early if the term is about to lapse`,
    };
  if (c.includes('index'))
    return {
      core: `Mint $${capital} of ${n}'s headline index token on ${chain} and hold it in the farming wallet`,
      weekly: `add $25 to the index position each week and keep the mint receipts with the farm log`,
    };
  if (c.includes('staking') || c.includes('restak'))
    return {
      core: `Stake $${capital} of the chain's staking asset through ${n} and keep the receipt token in the farming wallet`,
      weekly: `claim or compound the staking rewards once a week, whichever the protocol's own page offers`,
    };
  if (c.includes('stable') || c.includes('synthetic'))
    return {
      core: `Mint or deposit $${capital} of ${n}'s stable asset on ${chain} and hold it rather than swapping straight back out`,
      weekly: `make one more mint or deposit of $25 each week and keep the balance above the starting amount`,
    };
  return {
    core: `Deposit $${capital} of USDC into ${n} on ${chain} through its own interface and keep the position open`,
    weekly: `make one qualifying action on ${n} each week, such as a deposit, a swap, a vote or a claim`,
  };
}

/**
 * A protocol's farm plan: six steps, each an action with its cost and its time, derived from the
 * protocol's own record (category, first chain, TVL tier, age) and never from a list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(p);
  const hold = holdDaysFor(age);
  const { core, weekly } = actionsFor(p, capital, chain);
  return [
    `Start with a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline on paper. Cost: under $3 to fund it. Time: 5 minutes.`,
    `${core}. Cost: $${capital} of capital plus about $${gas} of gas. Time: 15 minutes to set up.`,
    `Come back on a schedule: ${weekly}. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity spans more than one weekly snapshot of the protocol. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Before withdrawing anything, open ${p.name}'s own points or rewards page and follow only the link it publishes; never pay a fee to claim an allocation. Cost: nothing to check. Time: 10 minutes.`,
    `Keep a farm log for ${p.name}: the wallet, the dates, the amounts and the transaction hashes, so the position can be repeated or unwound cleanly. Cost: nothing. Time: 5 minutes a week.`,
  ];
}

/** The board: every watchlist slug, plus every other rankable pre-token protocol, ranked by value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const cal = calibrate(snapshot);
  const watch = new Set(snapshot.watchlist);
  const chosen: SnapshotProtocol[] = [];
  let excluded = 0;
  for (const p of snapshot.protocols) {
    if (recordsToken(p)) continue;
    if (watch.has(p.slug)) {
      chosen.push(p);
    } else if (isProductOfTraded(p)) {
      excluded++;
    } else {
      chosen.push(p);
    }
  }
  const scored = chosen.map((p) => ({ p, v: impliedValue(p, snapshot.as_of, cal) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    on_watchlist: watch.has(s.p.slug),
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: s.v.multiple,
      calibration_n: s.v.calibrationN,
      momentum_factor: s.v.momentum,
      maturity_factor: s.v.maturity,
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The tokenized protocols, by market cap: the calibration set the dashboard shows apart. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 48)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : 0,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const cal = calibrate(snapshot);
  const live = liveRows(snapshot);
  const tokenized = snapshot.protocols.filter(recordsToken).length;
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    model: MODEL,
    global_median_ratio: cal.globalMedian,
    calibration: [...cal.table.values()].sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1)),
    counts: {
      protocols: snapshot.protocols.length,
      tokenized: tokenized,
      pre_token: snapshot.protocols.length - tokenized,
      board: board.length,
      watchlist: snapshot.watchlist.length,
      early: board.filter((r) => !watch.has(r.slug)).length,
      excluded_products: snapshot.protocols.filter((p) => !recordsToken(p) && !watch.has(p.slug) && isProductOfTraded(p)).length,
    },
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice on the board';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
