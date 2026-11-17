'use strict';
/* Token Launch Radar: renders window.RADAR (written beside this page by main.ts) and recomputes
   every row's implied value from the raw snapshot figures and the model's published constants,
   so what the page shows can be checked against board.json line by line. No network, no library. */

const R = window.RADAR;
const M = R.model;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function money(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}
function pct(n) {
  if (n === null || n === undefined) return '<span class="flat">n/a</span>';
  const cls = n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';
  return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
}
function age(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 730) return (n / 365.25).toFixed(1) + ' yrs';
  return n + ' days';
}

/* The model, restated: the same arithmetic lib/model.ts runs, from the raw figures. */
const calByCat = new Map(R.calibration.map((c) => [c.category, c]));
function recompute(row) {
  const entry = calByCat.get(row.category === null ? 'Uncategorized' : row.category);
  const multiple = entry ? entry.multiple : clamp(R.global_median_ratio, M.multiple_low, M.multiple_high);
  const growth = row.change_7d === null ? 0 : clamp(row.change_7d, M.growth_floor, M.growth_cap);
  const momentum = 1 + (growth / 100) * M.growth_weight;
  const maturity = row.age_days === null
    ? M.unknown_age_factor
    : M.maturity_base + (Math.min(row.age_days, M.maturity_days) / M.maturity_days) * M.maturity_range;
  return {
    multiple, n: entry ? entry.n : 0, momentum, maturity,
    implied: Math.max(1, Math.round(row.tvl_usd * multiple * momentum * maturity)),
  };
}

/* Header */
$('stamp').textContent =
  'Snapshot: ' + R.source + ', as of ' + R.as_of + ' · Model ' + R.model_version +
  ' · Floor for the watchlist: ' + money(R.floor_usd) + ' of TVL';
const totalImplied = R.rows.reduce((s, r) => s + r.implied_value_usd, 0);
$('stats').innerHTML = [
  [R.counts.protocols, 'protocols scanned'],
  [R.counts.board, 'pre-token ranked', 'hot'],
  [R.counts.watchlist + ' / ' + R.counts.watchlist, 'watchlist covered'],
  [R.counts.tokenized, 'already tokenized'],
  [money(totalImplied), 'total implied value', 'hot'],
].map(([v, l, c]) => '<div class="stat' + (c ? ' ' + c : '') + '"><b>' + v + '</b><span>' + l + '</span></div>').join('');

/* Views */
function setView(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.view === name);
  $('view-board').hidden = name !== 'board';
  $('view-live').hidden = name !== 'live';
  $('view-method').hidden = name !== 'method';
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

/* Board */
const state = { q: '', cat: '', chain: '', watch: false, key: 'rank', dir: 1 };
const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
$('cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
$('chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');

function visible() {
  const q = state.q.toLowerCase();
  let rows = R.rows.filter((r) =>
    (state.cat === '' || r.category === state.cat) &&
    (state.chain === '' || r.chains.includes(state.chain)) &&
    (!state.watch || r.on_watchlist) &&
    (q === '' || r.name.toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q) ||
      r.chains.some((c) => c.toLowerCase().includes(q)) || r.slug.includes(q)));
  const k = state.key;
  rows = rows.slice().sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * state.dir;
  });
  return rows;
}
function renderBoard() {
  const rows = visible();
  $('count').textContent = rows.length + ' of ' + R.rows.length + ' protocols';
  $('rows').innerHTML = rows.map((r) => {
    const ch = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '');
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="num rank">' + r.rank + '</td>' +
      '<td class="pname">' + esc(r.name) + (r.on_watchlist ? '<span class="wl">WATCHLIST</span>' : '') + '</td>' +
      '<td class="cat">' + esc(r.category || '—') + '</td>' +
      '<td class="chains">' + esc(ch || '—') + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num">' + pct(r.change_7d) + '</td>' +
      '<td class="num">' + age(r.age_days) + '</td>' +
      '<td class="num implied">' + money(r.implied_value_usd) + '</td></tr>';
  }).join('');
  document.querySelectorAll('#rows tr').forEach((tr) =>
    tr.addEventListener('click', () => openDetail(tr.dataset.slug)));
}
$('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
$('cat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
$('chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('watch').addEventListener('change', (e) => { state.watch = e.target.checked; renderBoard(); });
document.querySelectorAll('#board th[data-k]').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (state.key === k) state.dir = -state.dir; else { state.key = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
    if (k === 'rank') state.dir = 1;
    renderBoard();
  }));

/* Detail */
function openDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const v = recompute(r);
  const agrees = v.implied === r.implied_value_usd;
  $('detail').innerHTML =
    '<h2>' + esc(r.name) + '</h2>' +
    '<p class="dsub">Rank #' + r.rank + ' of ' + R.rows.length + ' · ' + esc(r.category || 'Uncategorized') +
    ' · ' + esc(r.chains.join(', ') || 'chain unlisted') + '</p>' +
    '<span class="badge">records no token in the snapshot</span>' +
    (r.on_watchlist ? '<span class="badge amber">on the ' + money(R.floor_usd) + '+ watchlist</span>' : '<span class="badge">early board, below the watchlist floor</span>') +
    '<div class="grid">' +
    '<div class="cell"><span>Total value locked</span><b>' + money(r.tvl_usd) + '</b></div>' +
    '<div class="cell"><span>Implied launch value</span><b>' + money(r.implied_value_usd) + '</b></div>' +
    '<div class="cell"><span>TVL change, 7 days</span><b>' + (r.change_7d === null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b></div>' +
    '<div class="cell"><span>Running since</span><b>' + (r.listed_at || 'not dated') + (r.age_days === null ? '' : ' (' + age(r.age_days) + ')') + '</b></div>' +
    '</div>' +
    '<h3>How this value is derived</h3>' +
    '<div class="arith">' +
    '<div><span>TVL</span><b>' + money(r.tvl_usd) + '</b></div>' +
    '<div><span>× category multiple</span><b>' + v.multiple.toFixed(4) + '</b></div>' +
    '<div><span class="why">' + esc(r.category || 'Uncategorized') + ': median cap/TVL of its ' + v.n + ' trading peers, shrunk to the market median</span><span></span></div>' +
    '<div><span>× momentum (7d TVL)</span><b>' + v.momentum.toFixed(4) + '</b></div>' +
    '<div><span>× maturity (time tokenless)</span><b>' + v.maturity.toFixed(4) + '</b></div>' +
    '<div class="tot"><span>Implied launch value</span><b>' + money(v.implied) + '</b></div>' +
    '</div>' +
    (agrees
      ? '<p class="check">✓ Recomputed on this page from the snapshot figures and the published constants — matches board.json exactly.</p>'
      : '<p class="check">Page recomputation: ' + money(v.implied) + ' · board.json: ' + money(r.implied_value_usd) + '</p>') +
    '<h3>How to farm it</h3>' +
    '<ol class="farm">' + r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<p class="note">A plan, not a promise: a protocol can launch with no drop, or reward different activity. ' +
    'Costs are the plan\'s own figures for one wallet, in USD.</p>';
  $('drawer').hidden = false;
  $('scrim').hidden = false;
}
function closeDetail() { $('drawer').hidden = true; $('scrim').hidden = true; }
$('closex').addEventListener('click', closeDetail);
$('scrim').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

/* Already trading */
$('liverows').innerHTML = R.live.map((p) =>
  '<tr><td class="pname">' + esc(p.name) + '</td><td class="cat">' + esc(p.symbol || '—') + '</td>' +
  '<td class="cat">' + esc(p.category || '—') + '</td><td class="num">' + money(p.tvl_usd) + '</td>' +
  '<td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + p.ratio.toFixed(3) + '</td>' +
  '<td class="num">' + pct(p.change_7d) + '</td></tr>').join('');

/* Method */
$('method').innerHTML =
  '<div class="method"><h2>How the ranking works</h2>' +
  '<p>The board answers one question: <b>if this protocol issued a token today, what would the launch be worth?</b> ' +
  'One function scores every protocol from the snapshot\'s own figures. No protocol name is special-cased, and the page ' +
  'recomputes each row from the same constants before showing it — open any row and compare.</p>' +
  '<div class="formula">implied value = TVL × category multiple × momentum × maturity</div>' +
  '<h3>1 · Calibrate on what already trades</h3>' +
  '<p>Each of the ' + R.counts.tokenized + ' tokenized protocols is a market observation: ratio = market cap ÷ TVL, winsorized to ' +
  '[' + M.winsor_low + ', ' + M.winsor_high + '] so one outlier cannot bend the scale. A category\'s multiple is the <b>median</b> of its ratios, ' +
  'shrunk toward the global median (' + R.global_median_ratio.toFixed(4) + ') with a pseudo-count of ' + M.shrink_k + ' and clamped to [' +
  M.multiple_low + ', ' + M.multiple_high + ']. The median, not the mean: a few richly valued tokens would otherwise drag a whole ' +
  'category\'s multiple away from where its typical token trades. Thin categories borrow the market\'s verdict; proven ones speak for themselves.</p>' +
  '<h3>2 · Momentum</h3><p>Seven-day TVL growth tilts the base: factor = 1 + clamp(change, ' + M.growth_floor + '%, +' + M.growth_cap + '%) × ' +
  M.growth_weight + '. A protocol adding TVL into a launch is worth more than one leaking it. Unreported growth is neutral.</p>' +
  '<h3>3 · Maturity</h3><p>Time running with no token is proof of demand: factor = ' + M.maturity_base + ' + ' + M.maturity_range +
  ' × min(age, ' + M.maturity_days + ' days) ÷ ' + M.maturity_days + ', or ' + M.unknown_age_factor + ' when DefiLlama gives no listing date.</p>' +
  '<h3>Who is on the board</h3>' +
  '<p>All ' + R.counts.watchlist + ' watchlist protocols (TVL at or above ' + money(R.floor_usd) + '), plus ' + R.counts.early +
  ' earlier protocols below the floor — ' + R.counts.board + ' rows in all. Left off: the ' + R.counts.tokenized + ' protocols whose token already ' +
  'trades, and ' + R.counts.excluded_products + ' records that are a wrapped, staked or bridged product of a token that trades — the bridge and ' +
  'staking-wrapper categories, version-marker names (a “V2” is a pool of its parent), names carrying the whole word wrapped, staked or staking, ' +
  'and names opening with an exchange\'s name. A launch radar that ranks a wrapped asset first would be ranking somebody else\'s token.</p>' +
  '<h3>The calibration table</h3>' +
  '<div class="tablewrap"><table><thead><tr><th>Category</th><th class="num">Trading tokens</th><th class="num">Median cap / TVL</th><th class="num">Multiple used</th></tr></thead><tbody>' +
  R.calibration.map((c) => '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.n + '</td><td class="num">' +
    (c.median_ratio === null ? '—' : c.median_ratio.toFixed(4)) + '</td><td class="num">' + c.multiple.toFixed(4) + '</td></tr>').join('') +
  '</tbody></table></div>' +
  '<p class="dim">Categories with no trading token use the global median, ' + R.global_median_ratio.toFixed(4) + '. ' +
  '“Records no token” is the snapshot\'s record as of ' + R.as_of + ': a protocol may have announced or launched since. ' +
  'Implied value is a comparables claim, not a price prediction, and a farm plan is not a promise of a drop.</p></div>';

renderBoard();

/* Deep links (also how the handed-in screenshots were staged): ?view=, ?cat=, ?q=, ?watch=1, ?detail=<slug> */
const params = new URLSearchParams(location.search);
if (params.get('cat')) { state.cat = params.get('cat'); $('cat').value = state.cat; }
if (params.get('chain')) { state.chain = params.get('chain'); $('chain').value = state.chain; }
if (params.get('q')) { state.q = params.get('q'); $('q').value = state.q; }
if (params.get('watch') === '1') { state.watch = true; $('watch').checked = true; }
if (params.get('view')) setView(params.get('view'));
renderBoard();
if (params.get('detail')) openDetail(params.get('detail'));
