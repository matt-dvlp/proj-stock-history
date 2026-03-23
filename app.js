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
    // fetch daily data + company overview in parallel
    const [dailyRes, overviewRes] = await Promise.all([
      fetch(`${API_BASE}?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=full&apikey=${key}`),
      fetch(`${API_BASE}?function=OVERVIEW&symbol=${ticker}&apikey=${key}`)
    ]);

    const [data, overview] = await Promise.all([dailyRes.json(), overviewRes.json()]);

    if (data['Note'] || data['Information']) throw new Error('API rate limit reached. Wait a minute and try again.');
    if (data['Error Message'])              throw new Error(`Unknown ticker: ${ticker}`);
    if (!data['Time Series (Daily)'])       throw new Error('No data returned. Check your API key or ticker.');

    const series   = data['Time Series (Daily)'];
    const allDates = Object.keys(series).sort(); // ascending
    const last7    = allDates.slice(-7);

    const closes  = last7.map(d => parseFloat(series[d]['4. close']));
    const highs   = last7.map(d => parseFloat(series[d]['2. high']));
    const lows    = last7.map(d => parseFloat(series[d]['3. low']));
    const latest  = series[last7[last7.length - 1]];
    const prev    = series[last7[last7.length - 2]];

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

    // ── history tables
    renderHistory('monthlyTable', buildMonthlyData(series, allDates));
    renderHistory('yearlyTable',  buildYearlyData(series, allDates));

    trackUsage(2); // 2 API calls per search (daily + overview)
    showResult();

  } catch (err) {
    showError(err.message);
  } finally {
    showLoader(false);
  }
}

// ── HISTORY BUILDERS ─────────────────────────────────────

// Returns the first available trading day on or after targetStr (YYYY-MM-DD)
// that falls within the same month.
function firstTradingDayInMonth(allDates, year, month) {
  const target    = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  return allDates.find(d => d >= target && d < nextMonth) || null;
}

// 1st trading day of each of the last 12 completed calendar months
function buildMonthlyData(series, allDates) {
  const rows = [];
  const now  = new Date();

  for (let i = 1; i <= 12; i++) {
    let year  = now.getFullYear();
    let month = now.getMonth() + 1 - i; // getMonth() is 0-based
    if (month <= 0) { month += 12; year -= 1; }

    const date = firstTradingDayInMonth(allDates, year, month);
    if (!date) continue;

    rows.push({
      label: new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      date,
      close: parseFloat(series[date]['4. close'])
    });
  }

  return rows.reverse(); // oldest → newest
}

// 1st trading day of January for each available year (excluding current year)
function buildYearlyData(series, allDates) {
  const rows        = [];
  const currentYear = new Date().getFullYear();
  const firstYear   = parseInt(allDates[0].split('-')[0]);

  for (let y = currentYear - 1; y >= firstYear; y--) {
    const date = firstTradingDayInMonth(allDates, y, 1);
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

function showLoader(on)  { document.getElementById('loader').hidden = !on; }
function hideResult()    { document.getElementById('result').hidden = true; }
function showResult()    { document.getElementById('result').hidden = false; }
function hideError()     { document.getElementById('errorBox').hidden = true; }
function showError(msg)  {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.hidden = false;
}

initBanner();
