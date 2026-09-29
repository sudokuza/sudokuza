const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1DbdIm2NEoMTARuqjCi0DcA1dyOr6Yce77F5EkLQoT3k/edit';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  stocks: [],
  market: {},
  meta: {},
  mode: 'snapshot',
  activeFilter: 'all',
  query: '',
  sort: 'score',
  sortDirection: 'desc',
  page: 1,
  pageSize: 25,
  favorites: new Set(),
  refreshing: false,
};

const favoriteStorageKey = 'sinyal-trend-watchlist-v1';
try {
  const saved = JSON.parse(localStorage.getItem(favoriteStorageKey) || '[]');
  state.favorites = new Set(Array.isArray(saved) ? saved : []);
} catch (_) {
  state.favorites = new Set();
}

const elements = {
  rows: $('#stock-rows'),
  empty: $('#empty-state'),
  search: $('#search-input'),
  tabs: $$('.filter-tab'),
  navItems: $$('.nav-item[data-nav]'),
  pageSize: $('#page-size'),
  resultCount: $('#result-count'),
  pageSummary: $('#page-summary'),
  pageNumber: $('#page-number'),
  prev: $('#prev-page'),
  next: $('#next-page'),
  filtersPanel: $('#advanced-filters'),
  filtersToggle: $('#filters-toggle'),
  filterCount: $('#filter-count'),
  syncStatus: $('#sync-status'),
  syncLabel: $('#sync-label'),
  refresh: $('#refresh-btn'),
  drawer: $('#detail-drawer'),
  drawerScrim: $('#drawer-scrim'),
  detail: $('#detail-content'),
  rulesModal: $('#rules-modal'),
};

const numberFormat = (digits = 2) => new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 0,
  maximumFractionDigits: digits,
});
const percentFormat = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 2) {
  const number = toNumber(value);
  return number === null ? 'N/A' : numberFormat(digits).format(number);
}

function formatPrice(value, prefix = true) {
  const number = toNumber(value);
  if (number === null) return 'N/A';
  return `${prefix ? 'Rp ' : ''}${numberFormat(0).format(number)}`;
}

function formatPercent(value, signed = true) {
  const number = toNumber(value);
  if (number === null) return 'N/A';
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${percentFormat.format(number)}%`;
}

function formatMultiple(value) {
  const number = toNumber(value);
  return number === null ? 'N/A' : `${numberFormat(2).format(number)}×`;
}

function formatTurnover(value, compact = false) {
  const number = toNumber(value);
  if (number === null) return 'N/A';
  const formatted = numberFormat(2).format(number);
  return compact ? `Rp ${formatted} M` : `Rp ${formatted} miliar`;
}

function currentWibDate() {
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta',
  }).format(new Date());
}

function currentWibTime() {
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Jakarta',
  }).format(new Date()).replace('.', ':') + ' WIB';
}

function setStatus(mode, text, sideText) {
  state.mode = mode;
  const dot = $('.status-dot', elements.syncStatus);
  const sideDot = $('#side-live-dot');
  dot?.classList.toggle('is-live', mode === 'live');
  sideDot?.classList.toggle('is-live', mode === 'live');
  elements.syncLabel.textContent = text || (mode === 'live' ? 'TradingView terhubung' : 'Snapshot lokal');
  $('#side-source-label').textContent = sideText || (mode === 'live' ? 'Quote · TradingView' : 'Memakai snapshot lokal');
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Gagal mengambil ${path}`);
  return response.json();
}

async function loadSnapshot() {
  if (window.SCREENER_SNAPSHOT && Array.isArray(window.SCREENER_SNAPSHOT.stocks)) {
    state.stocks = window.SCREENER_SNAPSHOT.stocks;
    state.market = window.SCREENER_SNAPSHOT.market || {};
    state.meta = window.SCREENER_SNAPSHOT.meta || {};
  } else {
    const [stocks, market, meta] = await Promise.all([
      fetchJson('data/stocks.json'),
      fetchJson('data/market.json'),
      fetchJson('data/meta.json').catch(() => ({})),
    ]);
    state.stocks = Array.isArray(stocks) ? stocks : [];
    state.market = market || {};
    state.meta = meta || {};
  }
  setStatus('snapshot', 'Snapshot lokal', 'Snapshot data');
  renderAll();
}

async function syncData(manual = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  const previousLabel = elements.syncLabel.textContent;
  elements.refresh.disabled = true;
  elements.refresh.classList.add('is-spinning');
  if (manual) setStatus(state.mode, 'Menyegarkan data…');
  try {
    const url = manual ? '/api/data?refresh=1' : '/api/data';
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('Endpoint data belum aktif');
    const result = await response.json();
    if (Array.isArray(result.stocks) && result.stocks.length) state.stocks = result.stocks;
    if (result.market && Object.keys(result.market).length) state.market = result.market;
    const isLive = result.source === 'tradingview';
    state.meta = { ...state.meta, ...(result.meta || {}), syncedAt: isLive ? (result.syncedAt || currentWibTime()) : '' };
    const quoteCount = result.coverage?.quoteAvailable ?? result.quoteCount ?? 0;
    const rowCount = result.coverage?.universe ?? result.rows ?? state.stocks.length;
    setStatus(
      isLive ? 'live' : 'snapshot',
      isLive ? `Quote tersedia · ${numberFormat(0).format(quoteCount)}/${numberFormat(0).format(rowCount)}` : 'Snapshot lokal',
      isLive ? 'Quote · TradingView' : 'Snapshot data',
    );
    renderAll();
  } catch (error) {
    setStatus('snapshot', 'Snapshot lokal', 'Snapshot data');
    if (!state.stocks.length) {
      elements.rows.innerHTML = '<tr><td colspan="11" class="loading-cell">Data belum dapat dimuat. Jalankan server lokal atau cek koneksi.</td></tr>';
    }
    if (manual) showToast('Sinkronisasi gagal. Snapshot tetap ditampilkan.');
  } finally {
    state.refreshing = false;
    elements.refresh.disabled = false;
    elements.refresh.classList.remove('is-spinning');
    if (!manual && elements.syncLabel.textContent === 'Memuat data…') elements.syncLabel.textContent = previousLabel;
  }
}

function trendKey(stock) {
  const trend = (stock.trend || '').toLowerCase();
  if (trend.includes('uptrend')) return 'uptrend';
  if (trend.includes('rebound')) return 'rebound';
  if (trend.includes('pullback')) return 'pullback';
  if (trend.includes('downtrend')) return 'downtrend';
  return 'other';
}

function isBullish(stock) {
  // Matches the Bullish filter in SINYAL&TREND: positive psychology plus KUAT.
  return /AKUMULASI|BREAKOUT|BULLISH/i.test(stock.psychology || '') && /KUAT/i.test(stock.strength || '');
}

function strengthGroup(stock) {
  const label = (stock.strength || '').toUpperCase();
  if (label.includes('KUAT')) return 'strong';
  if (label.includes('SEDANG')) return 'medium';
  if (label.includes('LEMAH')) return 'weak';
  return 'other';
}

function matchesQuickFilter(stock) {
  switch (state.activeFilter) {
    case 'candidate': return Boolean(stock.candidate);
    case 'bullish': return isBullish(stock);
    case 'uptrend': return trendKey(stock) === 'uptrend';
    case 'scalping': return stock.scalping === true;
    case 'swing': return stock.swing === true;
    case 'watchlist': return state.favorites.has(stock.ticker);
    default: return true;
  }
}

function readAdvancedFilters() {
  return {
    score: Number($('#min-score').value || 0),
    rvol: Number($('#min-rvol').value || 0),
    trend: $('#trend-filter').value,
    strength: $('#strength-filter').value,
    fast: $('#fast-filter').value,
    change: $('#change-filter').value,
    closeHigh: $('#close-high-filter').checked,
  };
}

function activeAdvancedCount() {
  const filters = readAdvancedFilters();
  return Number(filters.score > 0) + Number(filters.rvol > 0) + Number(filters.trend !== 'all') +
    Number(filters.strength !== 'all') + Number(filters.fast !== 'all') + Number(filters.change !== 'all') + Number(filters.closeHigh);
}

function getFilteredStocks() {
  const query = state.query.trim().toLowerCase();
  const filters = readAdvancedFilters();
  return state.stocks.filter((stock) => {
    if (!matchesQuickFilter(stock)) return false;
    if (query && !`${stock.ticker || ''} ${stock.name || ''}`.toLowerCase().includes(query)) return false;
    const score = toNumber(stock.score);
    const rvol = toNumber(stock.rvol);
    if (filters.score > 0 && (score === null || score < filters.score)) return false;
    if (filters.rvol > 0 && (rvol === null || rvol < filters.rvol)) return false;
    if (filters.trend !== 'all' && trendKey(stock) !== filters.trend) return false;
    if (filters.strength !== 'all' && strengthGroup(stock) !== filters.strength) return false;
    const fastScore = toNumber(stock.fastScore);
    if (filters.fast === 'hot' && !(fastScore >= 80)) return false;
    if (filters.fast === 'active' && !(fastScore >= 50 && fastScore < 80)) return false;
    if (filters.fast === 'skip' && !(fastScore !== null && fastScore < 50)) return false;
    const change = toNumber(stock.change);
    if (filters.change === 'positive' && !(change > 0)) return false;
    if (filters.change === 'negative' && !(change < 0)) return false;
    if (filters.change === 'flat' && !(change === 0)) return false;
    if (filters.closeHigh && !stock.closeHigh) return false;
    return true;
  }).sort(compareStocks);
}

function sortValue(stock, key) {
  switch (key) {
    case 'ticker': return stock.ticker || '';
    case 'price': return toNumber(stock.price);
    case 'change': return toNumber(stock.change);
    case 'score': return toNumber(stock.score);
    case 'rvol': return toNumber(stock.rvol);
    case 'position': return toNumber(stock.position);
    case 'strength': return stock.strength || '';
    case 'trend': return stock.trend || '';
    default: return stock[key];
  }
}

function compareStocks(a, b) {
  const av = sortValue(a, state.sort);
  const bv = sortValue(b, state.sort);
  if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
  if (bv === null || bv === undefined) return -1;
  let result = typeof av === 'number' && typeof bv === 'number'
    ? av - bv
    : String(av).localeCompare(String(bv), 'id', { sensitivity: 'base' });
  if (state.sortDirection === 'desc') result *= -1;
  return result;
}

function updateSortControls() {
  $$('.sort-button').forEach((button) => {
    const current = button.dataset.sort === state.sort;
    button.classList.toggle('current-sort', current);
    const arrow = $('span', button);
    if (arrow) arrow.textContent = current ? (state.sortDirection === 'desc' ? '↓' : '↑') : '↕';
  });
}

function badgeTone(text, type) {
  const value = (text || '').toUpperCase();
  if (type === 'trend') {
    if (value.includes('UPTREND')) return 'badge-positive';
    if (value.includes('REBOUND')) return 'badge-blue';
    if (value.includes('PULLBACK')) return 'badge-neutral';
    if (value.includes('DOWNTREND') || value.includes('BEARISH')) return 'badge-negative';
  }
  if (type === 'strength') {
    if (value.includes('KUAT')) return 'badge-positive';
    if (value.includes('SEDANG')) return 'badge-neutral';
    if (value.includes('LEMAH')) return 'badge-negative';
  }
  if (type === 'psychology') {
    if (value.includes('BULLISH') || value.includes('BREAKOUT') || value.includes('AKUMULASI')) return 'badge-positive';
    if (value.includes('SELL OFF') || value.includes('LEMAH')) return 'badge-negative';
    if (value.includes('NO VOLUME') || value.includes('DISTRIBUSI')) return 'badge-neutral';
  }
  return 'badge-muted';
}

function changeClass(value) {
  const number = toNumber(value);
  return number === null || number === 0 ? 'flat' : number > 0 ? 'up' : 'down';
}

function renderRow(stock) {
  const saved = state.favorites.has(stock.ticker);
  const score = toNumber(stock.score);
  const rawPosition = toNumber(stock.position);
  const positionWidth = rawPosition === null ? 0 : Math.max(0, Math.min(100, rawPosition * 100));
  const positionLabel = rawPosition === null ? 'N/A' : `${formatNumber(rawPosition * 100, 0)}%`;
  const rvol = toNumber(stock.rvol);
  const change = toNumber(stock.change);
  const trend = stock.trend || 'N/A';
  const strength = stock.strength || 'N/A';
  const fast = stock.fastTrade || 'N/A';
  const activity = stock.activity || 'N/A';
  const scoreMarkup = score === null
    ? '<span class="score-na">N/A</span>'
    : `<div class="score-head"><span class="score-value">${numberFormat(0).format(score)}</span><span class="score-track"><i style="width:${Math.max(0, Math.min(100, score))}%"></i></span></div>`;
  const positionTrackClass = rawPosition === null ? 'position-track is-missing' : 'position-track';
  if (!stock.quoteAvailable) {
    return `<tr class="no-quote-row" data-ticker="${esc(stock.ticker)}" tabindex="0" aria-label="Buka detail ${esc(stock.ticker)}">
    <td class="star-cell"><button class="star-button ${saved ? 'is-saved' : ''}" data-star="${esc(stock.ticker)}" type="button" aria-label="${saved ? 'Hapus dari' : 'Tambah ke'} watchlist" title="${saved ? 'Hapus dari' : 'Tambah ke'} watchlist">${saved ? '★' : '☆'}</button></td>
    <td><div class="stock-identity"><div class="stock-ticker-line"><span class="ticker-code">${esc(stock.ticker)}</span></div><span class="stock-name" title="${esc(stock.name)}">${esc(stock.name || 'N/A')}</span></div></td>
    <td colspan="8" class="no-quote-cell" title="${esc(stock.quoteNote || '')}">Tidak ada quote · kemungkinan suspen / delisting / kode belum tercatat di TradingView</td>
    <td class="row-chevron">›</td>
  </tr>`;
  }
  return `<tr data-ticker="${esc(stock.ticker)}" tabindex="0" aria-label="Buka detail ${esc(stock.ticker)}">
    <td class="star-cell"><button class="star-button ${saved ? 'is-saved' : ''}" data-star="${esc(stock.ticker)}" type="button" aria-label="${saved ? 'Hapus dari' : 'Tambah ke'} watchlist" title="${saved ? 'Hapus dari' : 'Tambah ke'} watchlist">${saved ? '★' : '☆'}</button></td>
    <td><div class="stock-identity"><div class="stock-ticker-line"><span class="ticker-code">${esc(stock.ticker)}</span>${stock.candidate === true ? '<span class="candidate-chip">Kandidat</span>' : ''}</div><span class="stock-name" title="${esc(stock.name)}">${esc(stock.name || 'N/A')}</span></div></td>
    <td><span class="price-main">${formatPrice(stock.price)}</span><span class="price-sub">Open ${formatNumber(stock.open, 0)}</span></td>
    <td><span class="change-value ${changeClass(change)}">${formatPercent(change)}</span></td>
    <td class="score-cell">${scoreMarkup}</td>
    <td class="column-rvol"><span class="rvol-value ${rvol >= 2 ? 'hot' : ''}">${formatMultiple(rvol)}</span></td>
    <td class="column-position"><div class="position-wrap"><span class="${positionTrackClass}"><i style="width:${positionWidth}%"></i></span><span class="position-value">${positionLabel}</span></div></td>
    <td><span class="badge ${badgeTone(strength, 'strength')}" title="${esc(strength)}">${esc(strength.replace(/^[^A-Z🟢🟡🟧🟥❌]+/u, ''))}</span></td>
    <td><span class="badge ${badgeTone(trend, 'trend')}" title="${esc(trend)}">${esc(trend)}</span></td>
    <td class="activity-cell column-activity" title="${esc(`${activity} · ${fast}`)}">${esc(activity)}</td>
    <td class="row-chevron">›</td>
  </tr>`;
}

function renderTable() {
  const filtered = getFilteredStocks();
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.max(1, Math.min(state.page, pages));
  const start = (state.page - 1) * state.pageSize;
  const pageItems = filtered.slice(start, start + state.pageSize);

  elements.resultCount.textContent = numberFormat(0).format(total);
  const candidateReady = state.meta?.candidateRuleReady === true;
  const candidateCount = state.stocks.filter((stock) => stock.candidate === true).length;
  $('#tab-all-count').textContent = numberFormat(0).format(state.stocks.length);
  $('#tab-candidate-count').textContent = candidateReady ? numberFormat(0).format(candidateCount) : 'N/A';
  $('#tab-watchlist-count').textContent = numberFormat(0).format(state.favorites.size);
  $('#side-universe').textContent = numberFormat(0).format(state.stocks.length);
  $('#side-candidates').textContent = candidateReady ? numberFormat(0).format(candidateCount) : 'N/A';
  $('#side-watchlist').textContent = numberFormat(0).format(state.favorites.size);
  $('#side-scalping').textContent = numberFormat(0).format(state.stocks.filter((stock) => stock.scalping === true).length);
  $('#side-swing').textContent = numberFormat(0).format(state.stocks.filter((stock) => stock.swing === true).length);
  ['candidate-tab', 'candidate-nav'].forEach((id) => {
    const control = $(`#${id}`);
    if (control) {
      control.disabled = !candidateReady;
      control.title = candidateReady ? '' : 'Aturan kandidat historis belum tersedia; nilai ditampilkan N/A.';
      control.setAttribute('aria-disabled', String(!candidateReady));
    }
  });
  elements.filterCount.textContent = String(activeAdvancedCount());
  elements.filtersToggle.classList.toggle('has-filters', activeAdvancedCount() > 0);

  if (!total) {
    elements.rows.innerHTML = '';
    elements.empty.hidden = false;
  } else {
    elements.empty.hidden = true;
    elements.rows.innerHTML = pageItems.map(renderRow).join('');
  }
  const shownStart = total ? start + 1 : 0;
  const shownEnd = total ? Math.min(start + state.pageSize, total) : 0;
  elements.pageSummary.textContent = `${numberFormat(0).format(shownStart)}–${numberFormat(0).format(shownEnd)} dari ${numberFormat(0).format(total)}`;
  elements.pageNumber.textContent = String(state.page);
  elements.prev.disabled = state.page <= 1;
  elements.next.disabled = state.page >= pages;
  updateSortControls();
  updateActiveControls();
}

function updateActiveControls() {
  elements.tabs.forEach((tab) => {
    const active = tab.dataset.filter === state.activeFilter;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  elements.navItems.forEach((item) => item.classList.toggle('active', item.dataset.nav === state.activeFilter));
}

function renderOverview() {
  const stocks = state.stocks;
  const market = state.market || {};
  const sentiment = market.sentimen || {};
  const candidateReady = state.meta?.candidateRuleReady === true;
  const candidateCount = stocks.filter((stock) => stock.candidate === true).length;
  const bullishCount = stocks.filter(isBullish).length;
  const quoteCount = toNumber(state.meta?.quoteCount) ?? stocks.filter((stock) => toNumber(stock.price) !== null).length;
  const rosterCount = toNumber(state.meta?.rosterCount) ?? stocks.length;
  $('#metric-universe').textContent = numberFormat(0).format(rosterCount);
  $('#page-universe').textContent = numberFormat(0).format(rosterCount);
  $('#metric-universe-foot').textContent = `${numberFormat(0).format(quoteCount)}/${numberFormat(0).format(rosterCount)} quote tersedia`;
  $('#metric-candidates').textContent = candidateReady ? numberFormat(0).format(candidateCount) : 'N/A';
  $('#metric-candidate-foot').textContent = candidateReady ? 'aturan Kandidat: lihat Aturan screener' : 'aturan historis belum tersedia';
  $('#metric-bullish').textContent = numberFormat(0).format(bullishCount);

  const sentimentScore = toNumber(sentiment.skor);
  const sentimentDirection = String(sentiment.arah || 'BELUM ADA').toUpperCase();
  $('#metric-sentiment-score').textContent = sentimentScore === null ? 'N/A' : `${sentimentScore > 0 ? '+' : ''}${numberFormat(2).format(sentimentScore)}`;
  const sentimentPill = $('#metric-sentiment-label');
  sentimentPill.textContent = sentimentDirection;
  sentimentPill.className = `sentiment-pill ${sentimentDirection.includes('POSITIF') ? 'positive' : sentimentDirection.includes('NETRAL') ? 'neutral' : ''}`;
  const ihsg = sentiment.ihsg || {};
  const ihsgChange = toNumber(ihsg.chgPct);
  $('#metric-sentiment-sub').textContent = ihsgChange === null ? 'gabungan indikator makro' : `IHSG ${formatPercent(ihsgChange)} hari ini`;
  const sentimentIndicator = $('#sentiment-indicator');
  sentimentIndicator.className = `metric-indicator ${sentimentDirection.includes('POSITIF') ? 'positive' : sentimentDirection.includes('NEGATIF') ? 'negative' : 'neutral'}`;
  const scaled = sentimentScore === null ? 50 : Math.max(3, Math.min(97, ((sentimentScore + 2) / 4) * 100));
  $('#sentiment-track-fill').style.left = `${scaled}%`;
  $('#today-label').textContent = currentWibDate();
  $('#year-label').textContent = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(new Date());
  renderDataNotice(quoteCount, rosterCount);
  renderMarketStrip();
}

function renderDataNotice(quoteCount, rosterCount) {
  const verified = state.meta?.rosterVerified === true;
  const candidateReady = state.meta?.candidateRuleReady === true;
  const rosterText = verified
    ? `Roster emiten diverifikasi dari IDX (${numberFormat(0).format(rosterCount)} kode).`
    : `Roster ${numberFormat(0).format(rosterCount)} kode masih sementara (snapshot KSEI + IPO 2026); belum dicocokkan satu per satu dengan IDX.`;
  const unavailable = Math.max(0, rosterCount - quoteCount);
  const quoteText = `${numberFormat(0).format(quoteCount)}/${numberFormat(0).format(rosterCount)} emiten punya quote; ${numberFormat(0).format(unavailable)} sisanya ditandai \"Tidak ada quote\" (umumnya suspen/delisting).`;
  const candidateText = candidateReady ? '' : ' Flag Kandidat belum aktif.';
  const note = $('#data-note-text');
  const staleText = state.mode === 'live' ? '' : '⚠ Data live gagal dimuat: tabel memakai snapshot lama, harga bukan real-time. ';
  const delayText = state.mode === 'live' ? ' Harga dari TradingView bisa tertunda; cocokkan dengan aplikasi sekuritas sebelum eksekusi.' : '';
  if (note) note.textContent = `${staleText}${rosterText} ${quoteText}${candidateText}${delayText}`;
}

function marketShortName(label) {
  const value = String(label || '');
  if (value.startsWith('EIDO')) return 'EIDO';
  if (value.startsWith('Minyak Brent')) return 'BRENT';
  if (value.startsWith('Emas')) return 'EMAS';
  if (value.startsWith('Dow Jones')) return 'DOW';
  if (value.startsWith('Nikkei')) return 'NIKKEI';
  if (value.startsWith('Hang Seng')) return 'HANG SENG';
  if (value.startsWith('VIX')) return 'VIX';
  return value;
}

function renderMarketStrip() {
  const container = $('#market-tickers');
  const market = state.market || {};
  const sentiment = market.sentimen || {};
  const list = [];
  if (sentiment.ihsg) list.push(sentiment.ihsg);
  if (Array.isArray(sentiment.item)) {
    list.push(...sentiment.item.filter((item) => ['EIDO', 'SP500', 'NASDAQ', 'DOW', 'VIX', 'NIKKEI', 'KOSPI', 'HSI'].includes(item.key)).slice(0, 6));
  }
  if (!list.length) {
    container.innerHTML = '<div class="ticker-loading">Ringkasan pasar belum tersedia</div>';
    return;
  }
  container.innerHTML = list.map((item) => {
    const change = toNumber(item.chgPct);
    const tone = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
    const price = toNumber(item.harga);
    const digits = price !== null && price >= 1000 ? 0 : 2;
    return `<div class="market-ticker"><span class="ticker-name">${esc(marketShortName(item.label || item.key))}</span><span class="ticker-value">${price === null ? 'N/A' : numberFormat(digits).format(price)}</span><span class="ticker-change ${tone}">${formatPercent(change)}</span></div>`;
  }).join('');
}

function updateTimestamp() {
  const synced = state.meta?.syncedAt;
  const snapshot = state.meta?.snapshotAt;
  const marketUpdated = state.market?.diperbarui;
  const live = state.mode === 'live';
  const display = live ? (synced || currentWibTime()) : (snapshot || marketUpdated || '—');
  $('#data-time').textContent = live ? display : `SNAPSHOT LAMA · ${display}`;
  $('#last-refresh-inline').textContent = live ? `Live · diambil ${display}` : `⚠ Snapshot lama · ${display}`;
}

function renderAll() {
  renderOverview();
  renderTable();
  updateTimestamp();
}

function scoreParts(stock) {
  const rvol = toNumber(stock.rvol);
  const position = toNumber(stock.position);
  const change = toNumber(stock.change);
  const turnover = toNumber(stock.turnover);
  const missing = 'N/A · data sumber tidak tersedia';
  return [
    { label: 'Relative volume 30D', note: rvol === null ? missing : `${formatMultiple(rvol)} · bobot maks. 40`, points: rvol === null ? null : Math.min(rvol, 3) / 3 * 40, max: 40 },
    { label: 'Posisi harga', note: position === null ? missing : `${formatNumber(position * 100, 0)}% dari low ke high · bobot maks. 25`, points: position === null ? null : position * 25, max: 25 },
    { label: 'Momentum harian', note: change === null ? missing : `${formatPercent(change)} · hanya kenaikan, maks. 5%`, points: change === null ? null : Math.min(Math.max(change, 0), 5) / 5 * 20, max: 20 },
    { label: 'Nilai transaksi', note: turnover === null ? missing : `${formatTurnover(turnover)} · bobot maks. 15`, points: turnover === null ? null : Math.min(turnover, 100) / 100 * 15, max: 15 },
  ];
}

function detailMetric(label, value) {
  return `<div class="detail-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function showDetail(ticker) {
  const stock = state.stocks.find((item) => item.ticker === ticker);
  if (!stock) return;
  const change = toNumber(stock.change);
  const score = toNumber(stock.score);
  const parts = scoreParts(stock);
  const allPartsAvailable = parts.every((part) => part.points !== null);
  const partTotal = allPartsAvailable ? parts.reduce((sum, part) => sum + part.points, 0) : null;
  const candidateTag = stock.candidate === true ? '<span class="candidate-chip drawer-candidate">KANDIDAT</span>' : '';
  const psychologyTone = badgeTone(stock.psychology, 'psychology');
  const trendTone = badgeTone(stock.trend, 'trend');
  const volatility = toNumber(stock.volatility);
  const volatilityPct = volatility === null ? 'N/A' : `${formatNumber(volatility * 100, 2)}%`;
  const partMarkup = parts.map((part) => {
    const ratio = part.points === null ? 0 : Math.max(0, Math.min(100, part.points / part.max * 100));
    const barClass = part.points === null ? 'signal-bar is-missing' : 'signal-bar';
    return `<div class="detail-signal-row"><div class="signal-row-copy"><strong>${esc(part.label)}</strong><small>${esc(part.note)}</small></div><span class="${barClass}"><i style="width:${ratio}%"></i></span><span class="signal-score">${formatNumber(part.points, 1)} / ${part.max}</span></div>`;
  }).join('');
  const closeHigh = stock.closeHigh === null || stock.closeHigh === undefined ? 'N/A' : stock.closeHigh ? 'Ya' : 'Tidak';
  const position = toNumber(stock.position);
  const candidateStatus = state.meta?.candidateRuleReady === true && stock.candidate !== null && stock.candidate !== undefined
    ? (stock.candidate ? 'Ya' : 'Tidak')
    : 'N/A';

  elements.detail.innerHTML = `
    <div class="detail-header">
      <div class="drawer-topline"><span class="drawer-label">PROFIL EMITEN · IDX</span><button class="drawer-close" id="drawer-close" type="button" aria-label="Tutup detail">×</button></div>
      <div class="drawer-stock-title"><div><div class="drawer-ticker">${esc(stock.ticker)}</div><div class="drawer-company">${esc(stock.name || 'N/A')}</div></div>${candidateTag}</div>
      <div class="drawer-price-line"><span class="drawer-price">${formatPrice(stock.price)}</span><span class="change-value ${changeClass(change)}">${formatPercent(change)}</span></div>
    </div>
    <div class="drawer-overview">
      <div class="detail-mini-card"><span>Score</span><strong>${score === null ? 'N/A' : numberFormat(0).format(score)}<small>/100</small></strong></div>
      <div class="detail-mini-card"><span>Relative volume</span><strong>${formatMultiple(stock.rvol)}</strong></div>
      <div class="detail-mini-card"><span>Psikologi pasar</span><strong><span class="badge ${psychologyTone}">${esc(stock.psychology || 'N/A')}</span></strong></div>
      <div class="detail-mini-card"><span>Tren MA20/50</span><strong><span class="badge ${trendTone}">${esc(stock.trend || 'N/A')}</span></strong></div>
    </div>
    <section class="detail-section">
      <div class="detail-section-title"><span>Anatomi score</span><small>formula sheet · dibulatkan</small></div>
      ${partMarkup}
      <div class="detail-signal-row"><div class="signal-row-copy"><strong>Total komponen</strong><small>Komponen yang tidak tersedia tidak dianggap nol.</small></div><span class="signal-score">${formatNumber(partTotal, 1)} pt</span></div>
    </section>
    <section class="detail-section">
      <div class="detail-section-title"><span>Snapshot teknikal</span><small>TradingView · saat scan</small></div>
      <div class="detail-metric-grid">
        ${detailMetric('Open', formatPrice(stock.open))}
        ${detailMetric('Low / high hari ini', `${formatNumber(stock.low, 0)} / ${formatNumber(stock.high, 0)}`)}
        ${detailMetric('Posisi harga', position === null ? 'N/A' : `${formatNumber(position * 100, 0)}%`)}
        ${detailMetric('Nilai transaksi', formatTurnover(stock.turnover))}
        ${detailMetric('Volume hari ini', formatNumber(stock.volume, 0))}
        ${detailMetric('Rata-rata volume 30D', formatNumber(stock.averageVolume30d, 0))}
        ${detailMetric('P/E ratio', toNumber(stock.pe) !== null && stock.pe > 0 ? formatNumber(stock.pe, 2) : (stock.quoteAvailable ? 'Rugi / tidak ada data' : 'N/A'))}
        ${detailMetric('Status valuasi', stock.valuation || 'N/A')}
        ${detailMetric('Volatilitas range harian', volatilityPct)}
        ${detailMetric('MA20 / MA50', `${formatPrice(stock.sma20)} / ${formatPrice(stock.sma50)}`)}
        ${detailMetric('Aktivitas volume', stock.activity || 'N/A')}
        ${detailMetric('Fast Trade', stock.fastTrade || 'N/A')}
        ${detailMetric('Close dekat high', closeHigh)}
        ${detailMetric('Flag kandidat', candidateStatus)}
        ${detailMetric('Cocok scalping', stock.scalping === true ? 'Ya' : stock.scalping === false ? 'Tidak' : 'N/A')}
        ${detailMetric('Cocok swing', stock.swing === true ? 'Ya' : stock.swing === false ? 'Tidak' : 'N/A')}
      </div>
    </section>
    <div class="detail-callout"><b>Catatan:</b> harga/volume/MA berasal dari TradingView; rumus score, psikologi, kekuatan, aktivitas, fast trade, tren, dan valuasi diimplementasikan dari spreadsheet. Field yang tidak tersedia tampil N/A. Flag Kandidat memakai aturan buatan sendiri (bukan dari sheet): ${esc(state.meta?.candidateNote || '')}</div>`;

  elements.drawerScrim.hidden = false;
  elements.drawer.classList.add('open');
  elements.drawer.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#drawer-close', elements.detail)?.addEventListener('click', closeDetail);
}

function closeDetail() {
  elements.drawer.classList.remove('open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawerScrim.hidden = true;
  document.body.style.overflow = '';
}

function openRules() {
  elements.rulesModal.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#rules-close').focus();
}

function closeRules() {
  elements.rulesModal.hidden = true;
  document.body.style.overflow = '';
}

function showToast(message) {
  let toast = $('#app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function setActiveFilter(filter) {
  state.activeFilter = filter;
  state.page = 1;
  renderTable();
}

function resetFilters() {
  state.activeFilter = 'all';
  state.query = '';
  state.page = 1;
  elements.search.value = '';
  $('#min-score').value = '0';
  $('#min-rvol').value = '0';
  $('#trend-filter').value = 'all';
  $('#strength-filter').value = 'all';
  $('#fast-filter').value = 'all';
  $('#change-filter').value = 'all';
  $('#close-high-filter').checked = false;
  renderTable();
}

function exportCsv() {
  const filtered = getFilteredStocks();
  if (!filtered.length) {
    showToast('Tidak ada baris untuk diekspor.');
    return;
  }
  const headers = ['Kode Emiten', 'Nama Perusahaan', 'Harga', 'Open', 'Perubahan %', 'Score', 'RVOL', 'Posisi Harga', 'Nilai Transaksi (Rp miliar)', 'Psikologi Pasar', 'Kekuatan Sinyal', 'Aktivitas', 'Fast Trade', 'Tren MA20/50', 'Kandidat', 'Scalping', 'Swing'];
  const rows = filtered.map((stock) => [
    stock.ticker, stock.name, stock.price, stock.open, stock.change, stock.score, stock.rvol,
    stock.position, stock.turnover, stock.psychology, stock.strength, stock.activity,
    stock.fastTrade, stock.trend, stock.candidate === null || stock.candidate === undefined ? 'N/A' : stock.candidate ? 'Ya' : 'Tidak',
    stock.scalping === null || stock.scalping === undefined ? 'N/A' : stock.scalping ? 'Ya' : 'Tidak',
    stock.swing === null || stock.swing === undefined ? 'N/A' : stock.swing ? 'Ya' : 'Tidak',
  ]);
  const csv = [headers, ...rows].map((row) => row.map((value) => {
    const safeValue = String(value ?? '').replace(/"/g, '""');
    return `"${safeValue}"`;
  }).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `screener-idx-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${numberFormat(0).format(filtered.length)} saham diekspor ke CSV.`);
}

function bindEvents() {
  elements.tabs.forEach((tab) => tab.addEventListener('click', () => setActiveFilter(tab.dataset.filter)));
  elements.navItems.forEach((item) => item.addEventListener('click', () => {
    setActiveFilter(item.dataset.nav);
    if (item.dataset.nav === 'all') window.scrollTo({ top: 0, behavior: 'smooth' });
    else $('#screener').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#rules-open').addEventListener('click', openRules);
  $('#rules-open-secondary').addEventListener('click', openRules);
  $('#footer-rules').addEventListener('click', openRules);
  $('#rules-close').addEventListener('click', closeRules);
  elements.rulesModal.addEventListener('click', (event) => { if (event.target === elements.rulesModal) closeRules(); });
  elements.drawerScrim.addEventListener('click', closeDetail);
  elements.refresh.addEventListener('click', () => syncData(true));
  $('#export-btn').addEventListener('click', exportCsv);
  $('#open-source').addEventListener('click', () => window.open(SHEET_URL, '_blank', 'noopener,noreferrer'));

  elements.search.addEventListener('input', () => {
    state.query = elements.search.value;
    state.page = 1;
    renderTable();
  });
  elements.pageSize.addEventListener('change', () => {
    state.pageSize = Number(elements.pageSize.value) || 25;
    state.page = 1;
    renderTable();
  });
  elements.prev.addEventListener('click', () => { state.page -= 1; renderTable(); });
  elements.next.addEventListener('click', () => { state.page += 1; renderTable(); });
  $$('.sort-button').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    if (state.sort === key) state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    else {
      state.sort = key;
      state.sortDirection = key === 'ticker' ? 'asc' : 'desc';
    }
    state.page = 1;
    renderTable();
  }));
  elements.filtersToggle.addEventListener('click', () => {
    const isHidden = elements.filtersPanel.hidden;
    elements.filtersPanel.hidden = !isHidden;
    elements.filtersToggle.setAttribute('aria-expanded', String(isHidden));
  });
  ['min-score', 'min-rvol', 'trend-filter', 'strength-filter', 'fast-filter', 'change-filter', 'close-high-filter'].forEach((id) => {
    $(`#${id}`).addEventListener('change', () => { state.page = 1; renderTable(); });
  });
  $('#clear-filters').addEventListener('click', resetFilters);
  $('#empty-reset').addEventListener('click', resetFilters);
  elements.rows.addEventListener('click', (event) => {
    const star = event.target.closest('[data-star]');
    if (star) {
      event.stopPropagation();
      const ticker = star.dataset.star;
      if (state.favorites.has(ticker)) state.favorites.delete(ticker);
      else state.favorites.add(ticker);
      try { localStorage.setItem(favoriteStorageKey, JSON.stringify([...state.favorites])); } catch (_) { /* storage can be disabled */ }
      renderTable();
      return;
    }
    const row = event.target.closest('tr[data-ticker]');
    if (row) showDetail(row.dataset.ticker);
  });
  elements.rows.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-ticker]')) {
      event.preventDefault();
      showDetail(event.target.dataset.ticker);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!elements.rulesModal.hidden) closeRules();
      if (elements.drawer.classList.contains('open')) closeDetail();
    }
    if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      event.preventDefault();
      elements.search.focus();
    }
  });
}

function isMarketHoursWib() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  if (['Sat', 'Sun'].includes(get('weekday'))) return false;
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  return minutes >= 8 * 60 + 55 && minutes <= 16 * 60 + 10; // 08:55-16:10 WIB
}

function startAutoRefresh() {
  // Segarkan tiap 60 detik selama jam bursa, dan langsung saat tab dibuka kembali.
  setInterval(() => { if (!document.hidden && isMarketHoursWib()) syncData(false); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncData(false); });
}

async function init() {
  bindEvents();
  $('#today-label').textContent = currentWibDate();
  setStatus('snapshot', 'Memuat snapshot…', 'Snapshot data');
  try {
    await loadSnapshot();
  } catch (error) {
    console.warn('Snapshot lokal gagal dimuat', error);
    elements.rows.innerHTML = '<tr><td colspan="11" class="loading-cell">Memuat data screener…</td></tr>';
  }
  await syncData(false);
  startAutoRefresh();
  if (state.stocks.length) renderAll();
}

init();
