const API_BASE = 'https://www.alphavantage.co/query';
let chart = null;

// ── API KEY ──────────────────────────────────────────────
const apiBanner   = document.getElementById('apiBanner');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn  = document.getElementById('saveKeyBtn');

function getApiKey() {
  return localStorage.getItem('av_api_key') || '';
}

// ── USAGE TRACKING ───────────────────────────────────────
const DAILY_LIMIT = 25;

function getUsage() {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem('av_usage_date') !== today) {
    localStorage.setItem('av_usage_date', today);
    localStorage.setItem('av_usage_count', '0');
  }
  return parseInt(localStorage.getItem('av_usage_count') || '0');
}

function trackUsage(calls) {
  const count = getUsage() + calls;
  localStorage.setItem('av_usage_count', String(count));
  updateUsageDisplay();
}

function updateUsageDisplay() {
  const used  = getUsage();
  const pct   = Math.min((used / DAILY_LIMIT) * 100, 100);
  document.getElementById('usageText').textContent = `${used} / ${DAILY_LIMIT} calls today`;
  const fill = document.getElementById('usageFill');
  fill.style.width = pct + '%';
  fill.style.background = pct >= 80 ? '#f87171' : pct >= 50 ? '#fbbf24' : '#34d399';
}

// ── KEY CONNECT / DISCONNECT ─────────────────────────────
function initBanner() {
  if (getApiKey()) {
    apiBanner.classList.add('hidden');
    showKeyStatus();
  }
}

function showKeyStatus() {
  document.getElementById('keyStatus').hidden = false;
  updateUsageDisplay();
}

saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  localStorage.setItem('av_api_key', key);
  apiBanner.classList.add('hidden');
  showKeyStatus();
});

document.getElementById('disconnectBtn').addEventListener('click', () => {
  localStorage.removeItem('av_api_key');
  localStorage.removeItem('av_usage_count');
  localStorage.removeItem('av_usage_date');
  document.getElementById('keyStatus').hidden = true;
  apiBanner.classList.remove('hidden');
  apiKeyInput.value = '';
  hideResult();
  hideError();
});

// ── SEARCH ──────────────────────────────────────────────
const tickerInput = document.getElementById('tickerInput');
const searchBtn   = document.getElementById('searchBtn');

searchBtn.addEventListener('click', search);
tickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });

async function search() {
  const ticker = tickerInput.value.trim().toUpperCase();
  if (!ticker) return;

  const key = getApiKey();
  if (!key) { showError('Please save your Alpha Vantage API key first.'); return; }

  showLoader(true);
  hideError();
  hideResult();

  try {
    // 1. Daily compact (free) — last 100 days, enough for 7d chart
    const daily = await apiFetch(`${API_BASE}?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${key}`);
    if (!daily['Time Series (Daily)']) throw new Error(`Unknown ticker: ${ticker}`);

    // 2. Monthly (free, full history) — for monthly & yearly tables
    await delay(1100);
    const monthly = await apiFetch(`${API_BASE}?function=TIME_SERIES_MONTHLY&symbol=${ticker}&apikey=${key}`);
    if (!monthly['Monthly Time Series']) throw new Error('Could not load monthly data.');

    // 3. Overview (non-critical, free)
    await delay(1100);
    const overview = await apiFetch(`${API_BASE}?function=OVERVIEW&symbol=${ticker}&apikey=${key}`)
      .catch(() => ({}));

    // ── daily series (chart + stats)
    const dailySeries = daily['Time Series (Daily)'];
    const dailyDates  = Object.keys(dailySeries).sort();
    const last7       = dailyDates.slice(-7);

    const closes  = last7.map(d => parseFloat(dailySeries[d]['4. close']));
    const highs   = last7.map(d => parseFloat(dailySeries[d]['2. high']));
    const lows    = last7.map(d => parseFloat(dailySeries[d]['3. low']));
    const latest  = dailySeries[last7[last7.length - 1]];
    const prev    = dailySeries[last7[last7.length - 2]];

    const lastClose = parseFloat(latest['4. close']);
    const prevClose = parseFloat(prev['4. close']);
    const change    = lastClose - prevClose;
    const changePct = (change / prevClose) * 100;

    // ── header
    const companyName = overview['Name'] || ticker;
    const exchange    = overview['Exchange'] ? ` · ${overview['Exchange']}` : '';
    document.getElementById('stockName').textContent        = companyName;
    document.getElementById('stockTickerLabel').textContent = ticker + exchange;
    document.getElementById('stockPrice').textContent       = `$${lastClose.toFixed(2)}`;

    const changeEl = document.getElementById('stockChange');
    changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct.toFixed(2)}%)`;
    changeEl.className   = 'stock-change ' + (change >= 0 ? 'up' : 'down');

    // ── stats
    document.getElementById('statOpen').textContent   = `$${parseFloat(latest['1. open']).toFixed(2)}`;
    document.getElementById('statHigh').textContent   = `$${parseFloat(latest['2. high']).toFixed(2)}`;
    document.getElementById('statLow').textContent    = `$${parseFloat(latest['3. low']).toFixed(2)}`;
    document.getElementById('statVolume').textContent = formatVolume(parseInt(latest['5. volume']));
    document.getElementById('stat7High').textContent  = `$${Math.max(...highs).toFixed(2)}`;
    document.getElementById('stat7Low').textContent   = `$${Math.min(...lows).toFixed(2)}`;

    // ── chart (unchanged)
    renderChart(last7, closes, closes[0] <= closes[closes.length - 1]);

    // ── history tables (built from monthly series)
    const monthlySeries = monthly['Monthly Time Series'];
    const monthlyDates  = Object.keys(monthlySeries).sort(); // ascending, end-of-month dates
    renderHistory('monthlyTable', buildMonthlyData(monthlySeries, monthlyDates));
    renderHistory('yearlyTable',  buildYearlyData(monthlySeries, monthlyDates));

    trackUsage(3); // 3 API calls per search
    showResult();

  } catch (err) {
    showError(err.message);
  } finally {
    showLoader(false);
  }
}

// ── HISTORY BUILDERS (monthly series) ────────────────────
// Monthly series dates are end-of-month trading days (e.g. 2024-01-31)

// Last 12 months — one entry per month
function buildMonthlyData(series, allDates) {
  const rows = [];
  const now  = new Date();

  for (let i = 1; i <= 12; i++) {
    let year  = now.getFullYear();
    let month = now.getMonth() + 1 - i;
    if (month <= 0) { month += 12; year -= 1; }

    const ym   = `${year}-${String(month).padStart(2, '0')}`;
    const date = allDates.find(d => d.startsWith(ym));
    if (!date) continue;

    rows.push({
      label: new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      date,
      close: parseFloat(series[date]['4. close'])
    });
  }

  return rows.reverse(); // oldest → newest
}

// One entry per year — last trading day of January for each available year
function buildYearlyData(series, allDates) {
  const rows        = [];
  const currentYear = new Date().getFullYear();
  const firstYear   = parseInt(allDates[0].split('-')[0]);

  for (let y = currentYear - 1; y >= firstYear; y--) {
    const date = allDates.find(d => d.startsWith(`${y}-01`));
    if (!date) continue;
    rows.push({ label: String(y), date, close: parseFloat(series[date]['4. close']) });
  }

  return rows.reverse(); // oldest → newest
}

// ── RENDER HISTORY TABLE ─────────────────────────────────
function renderHistory(elementId, rows) {
  const container = document.getElementById(elementId);
  container.innerHTML = '';

  if (!rows.length) {
    container.innerHTML = '<div class="hrow-empty">No data available</div>';
    return;
  }

  // header row
  const header = document.createElement('div');
  header.className = 'hrow hrow-head';
  header.innerHTML = '<span>Period</span><span>Date</span><span>Close</span><span>Change</span>';
  container.appendChild(header);

  rows.forEach((row, i) => {
    const prev   = i > 0 ? rows[i - 1].close : null;
    const pct    = prev != null ? ((row.close - prev) / prev) * 100 : null;
    const pctStr = pct != null
      ? `<span class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`
      : '<span class="neutral">—</span>';

    const el = document.createElement('div');
    el.className = 'hrow';
    el.innerHTML = `
      <span class="hrow-label">${row.label}</span>
      <span class="hrow-date">${row.date}</span>
      <span class="hrow-price">$${row.close.toFixed(2)}</span>
      <span>${pctStr}</span>
    `;
    container.appendChild(el);
  });
}

// ── API HELPERS ──────────────────────────────────────────
async function apiFetch(url) {
  const res  = await fetch(url);
  const data = await res.json();
  if (data['Note'])        throw new Error('Per-minute limit hit (5 req/min). Wait a moment.');
  if (data['Information']) throw new Error(data['Information']);
  return data;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── CHART (unchanged) ────────────────────────────────────
function renderChart(labels, data, isUp) {
  const ctx   = document.getElementById('priceChart').getContext('2d');
  const color = isUp ? '#34d399' : '#f87171';

  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, isUp ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: color,
        borderWidth: 2.5,
        backgroundColor: gradient,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: color,
        pointRadius: 4,
        pointHoverRadius: 6,
      }]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,15,30,0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#888',
          bodyColor: '#f0f0f0',
          callbacks: { label: ctx => ` $${ctx.parsed.y.toFixed(2)}` }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#555', font: { size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#555', font: { size: 11 }, callback: v => `$${v.toFixed(0)}` }
        }
      }
    }
  });
}

// ── HELPERS ──────────────────────────────────────────────
function formatVolume(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function showLoader(on)  {
  document.getElementById('loader').hidden = !on;
  document.getElementById('searchBtn').disabled = on;
}
function hideResult()    { document.getElementById('result').hidden = true; }
function showResult()    { document.getElementById('result').hidden = false; }
function hideError()     { document.getElementById('errorBox').hidden = true; }
function showError(msg)  {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.hidden = false;
}

initBanner();
