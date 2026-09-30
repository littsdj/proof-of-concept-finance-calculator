/* Horizon — front-end-only retirement projection.
   Everything runs in the browser: read the form, simulate year by year, draw with D3. */
(() => {
  'use strict';

  const STORAGE_KEY = 'horizon.inputs.v1';
  const THEME_KEY = 'horizon.theme';
  const THIS_YEAR = new Date().getFullYear();
  const ACCOUNTS = [
    { key: 'roth', name: 'Roth', color: 'var(--roth)' },
    { key: 'trad', name: 'Traditional', color: 'var(--trad)' },
    { key: 'taxable', name: 'Taxable', color: 'var(--taxable)' },
  ];
  const OTHER = { key: 'other', name: 'Other assets', color: 'var(--other)' };

  const DEFAULTS = {
    age: 32, retireAge: 60, planAge: 92,
    income: 120000, incomeGrowth: 3.5, savingsRate: 22,
    netWorth: 185000,
    roth: 35000, trad: 70000, taxable: 40000,
    splitRoth: 30, splitTrad: 45, splitTaxable: 25,
    returnPre: 7, returnPost: 5, inflation: 2.5,
    spending: 55000, taxRate: 18, swr: 4,
    expenses: [
      { label: 'Home down payment', age: 35, amount: 80000 },
      { label: 'New car', age: 42, amount: 40000 },
      { label: 'Kids’ college', age: 50, amount: 120000 },
    ],
  };
  const MONEY_FIELDS = ['income', 'netWorth', 'roth', 'trad', 'taxable', 'spending'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const form = $('#plan-form');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = { inputs: null, sim: null, units: 'real', revealed: new Set(), journeyProgress: 0 };

  /* ---------------------------------------------------------------- storage */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  /* ------------------------------------------------------------- formatting */
  const parseMoney = (s) => {
    const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  };
  const withCommas = (n) => Math.round(n).toLocaleString('en-US');
  function fmt(v) {
    if (!Number.isFinite(v)) return '—';
    const sign = v < 0 ? '−' : '';
    const a = Math.abs(v);
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e7) return `${sign}$${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}k`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`;
    return `${sign}$${Math.round(a)}`;
  }
  const fmtFull = (v) => (v < 0 ? '−$' : '$') + withCommas(Math.abs(v));
  const axisFmt = (v) => (v === 0 ? '$0' : fmt(v).replace('.00', '').replace(/\.0(?=[MkB])/, ''));

  /** Convert a nominal amount at row r into the selected units. */
  const u = (v, r) => (state.units === 'real' ? v / r.deflator : v);

  /* ------------------------------------------------------------------ form */
  function fillForm(inputs) {
    for (const [k, v] of Object.entries(inputs)) {
      const el = form.elements[k];
      if (!el || k === 'expenses') continue;
      el.value = MONEY_FIELDS.includes(k) ? withCommas(v) : v;
    }
    renderExpenseRows(inputs.expenses);
    updateLiveHints();
  }

  function renderExpenseRows(list) {
    const wrap = $('#expenses');
    wrap.replaceChildren();
    list.forEach((e) => wrap.appendChild(expenseRow(e)));
    toggleEmptyExpenses();
  }

  function expenseRow(e = { label: '', age: '', amount: '' }) {
    const row = document.createElement('div');
    row.className = 'expense';
    row.innerHTML = `
      <label class="field"><span>What</span><div class="input"><input type="text" data-exp="label" maxlength="40" placeholder="e.g. Wedding"></div></label>
      <label class="field"><span>At age</span><div class="input"><input type="number" data-exp="age" inputmode="numeric" min="0" max="120" step="1"></div></label>
      <label class="field"><span>Cost</span><div class="input"><i>$</i><input type="text" data-exp="amount" data-money inputmode="decimal"></div></label>
      <button type="button" class="icon-btn" aria-label="Remove expense"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    $('[data-exp="label"]', row).value = e.label;
    $('[data-exp="age"]', row).value = e.age;
    $('[data-exp="amount"]', row).value = e.amount === '' ? '' : withCommas(e.amount);
    $('.icon-btn', row).addEventListener('click', () => { row.remove(); toggleEmptyExpenses(); });
    return row;
  }

  function toggleEmptyExpenses() {
    const wrap = $('#expenses');
    const empty = $('.expenses-empty', wrap);
    const hasRows = $$('.expense', wrap).length > 0;
    if (!hasRows && !empty) {
      const p = document.createElement('p');
      p.className = 'expenses-empty';
      p.textContent = 'No big expenses yet. Add a house, car, tuition, or anything else you expect to pay for.';
      wrap.appendChild(p);
    } else if (hasRows && empty) empty.remove();
  }

  function readForm() {
    const f = form.elements;
    const num = (k) => (MONEY_FIELDS.includes(k) ? parseMoney(f[k].value) : parseFloat(f[k].value));
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (k !== 'expenses') out[k] = num(k);
    out.expenses = $$('.expense').map((row) => ({
      label: $('[data-exp="label"]', row).value.trim() || 'Expense',
      age: parseInt($('[data-exp="age"]', row).value, 10),
      amount: parseMoney($('[data-exp="amount"]', row).value),
    })).filter((e) => Number.isFinite(e.age) && Number.isFinite(e.amount) && e.amount > 0);
    return out;
  }

  function validate(i) {
    $$('.input.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
    const bad = [];
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'expenses') continue;
      if (!Number.isFinite(i[k])) bad.push(k);
    }
    bad.forEach((k) => form.elements[k].closest('.input').classList.add('is-invalid'));
    if (bad.length) return 'Fill in every field with a number. Highlighted fields are missing or unreadable.';
    if (i.age < 16 || i.age > 100) return 'Current age needs to be between 16 and 100.';
    if (i.planAge <= i.age) return 'Plan-to age needs to be later than your current age.';
    if (i.planAge - i.age > 90) return 'Keep the projection under 90 years by lowering your plan-to age.';
    if (i.retireAge < i.age || i.retireAge > i.planAge) return 'Retirement age needs to fall between your current age and your plan-to age.';
    if (i.splitRoth + i.splitTrad + i.splitTaxable <= 0 && i.savingsRate > 0) return 'Give at least one account a share of new savings.';
    if (i.taxRate >= 100) return 'Tax on traditional withdrawals needs to be under 100%.';
    return null;
  }

  function updateLiveHints() {
    const f = form.elements;
    const splits = { roth: +f.splitRoth.value || 0, trad: +f.splitTrad.value || 0, taxable: +f.splitTaxable.value || 0 };
    const total = splits.roth + splits.trad + splits.taxable;
    for (const [k, v] of Object.entries(splits)) {
      $(`.split-bar [data-k="${k}"]`).style.flexGrow = total > 0 ? v : 0;
    }
    const note = $('.split-note');
    note.classList.toggle('is-off', Math.round(total) !== 100);
    note.textContent = Math.round(total) === 100
      ? 'New savings split: 100% allocated.'
      : `Shares add up to ${Math.round(total)}%. They'll be scaled to 100% when you build the projection.`;

    const other = parseMoney(f.netWorth.value) - parseMoney(f.roth.value) - parseMoney(f.trad.value) - parseMoney(f.taxable.value);
    const out = $('#other-assets');
    out.textContent = Number.isFinite(other) ? fmtFull(other) : '—';
    out.parentElement.classList.toggle('is-off', other < 0);
  }

  /* ------------------------------------------------------------- simulation */
  function simulate(i) {
    const g = i.incomeGrowth / 100, sr = i.savingsRate / 100, inf = i.inflation / 100;
    const rPre = i.returnPre / 100, rPost = i.returnPost / 100, tax = i.taxRate / 100, swr = i.swr / 100;
    const splitTotal = i.splitRoth + i.splitTrad + i.splitTaxable || 1;
    const split = { roth: i.splitRoth / splitTotal, trad: i.splitTrad / splitTotal, taxable: i.splitTaxable / splitTotal };
    const bal = { roth: i.roth, trad: i.trad, taxable: i.taxable };
    let other = i.netWorth - i.roth - i.trad - i.taxable;
    let cumContrib = 0, cumGrowth = 0;
    const rows = [];

    // Pull `need` (after-tax dollars) from accounts in order; traditional withdrawals are grossed up for tax.
    const withdraw = (need, order) => {
      const taken = { roth: 0, trad: 0, taxable: 0 };
      for (const k of order) {
        if (need <= 0.005) break;
        const avail = Math.max(0, bal[k]);
        const net = k === 'trad' ? avail * (1 - tax) : avail;
        const useNet = Math.min(net, need);
        const gross = k === 'trad' ? useNet / (1 - tax) : useNet;
        bal[k] -= gross; taken[k] += gross; need -= useNet;
      }
      return { taken, shortfall: Math.max(0, need) };
    };

    for (let age = i.age; age <= i.planAge; age++) {
      const t = age - i.age;
      const deflator = Math.pow(1 + inf, t);
      const working = age < i.retireAge;
      const start = { roth: bal.roth, trad: bal.trad, taxable: bal.taxable };
      const invested = start.roth + start.trad + start.taxable;
      const row = {
        age, year: THIS_YEAR + t, t, deflator, working,
        ...start, other, invested, netWorth: invested + other,
        income: 0, contrib: 0, growth: 0, spending: 0, expenseCost: 0, withdrawn: 0,
        events: [], shortfall: 0, spendShortfall: 0,
      };

      // Big expenses this year (today's dollars, inflated)
      for (const e of i.expenses) {
        if (e.age !== age) continue;
        const cost = e.amount * deflator;
        const res = withdraw(cost, ['taxable', 'roth', 'trad']);
        row.expenseCost += cost;
        row.shortfall += res.shortfall;
        row.withdrawn += res.taken.roth + res.taken.trad + res.taken.taxable;
        row.events.push({ ...e, cost, shortfall: res.shortfall });
      }

      if (working) {
        row.income = i.income * Math.pow(1 + g, t);
        row.contrib = row.income * sr;
      } else {
        row.spending = i.spending * deflator;
        const res = withdraw(row.spending, ['taxable', 'trad', 'roth']);
        row.spendShortfall = res.shortfall;
        row.shortfall += res.shortfall;
        row.withdrawn += res.taken.roth + res.taken.trad + res.taken.taxable;
      }

      // Growth: balances after withdrawals grow a full year; contributions arrive through the year (half-year growth).
      const r = working ? rPre : rPost;
      for (const k of ['roth', 'trad', 'taxable']) {
        const c = row.contrib * split[k];
        const gr = Math.max(0, bal[k]) * r + c * r * 0.5;
        bal[k] = Math.max(0, bal[k] + c + gr);
        row.growth += gr;
      }
      cumContrib += row.contrib; cumGrowth += row.growth;
      row.cumContrib = cumContrib; row.cumGrowth = cumGrowth;
      other *= 1 + inf;
      rows.push(row);
    }

    const retireRow = rows.find((r) => r.age === i.retireAge) || rows[rows.length - 1];
    const fiRow = rows.find((r) => r.invested * swr >= i.spending * r.deflator);
    const crossRow = rows.find((r) => r.working && r.contrib > 0 && r.growth > r.contrib);
    const depleteRow = rows.find((r) => !r.working && r.spendShortfall > 0.5);
    const endRow = rows[rows.length - 1];
    const workRows = rows.filter((r) => r.working);
    return {
      inputs: i, rows, retireRow, fiRow, crossRow, depleteRow, endRow,
      contribToRetire: workRows.reduce((s, r) => s + r.contrib, 0),
      growthToRetire: workRows.reduce((s, r) => s + r.growth, 0),
      workRows,
      retireRows: rows.filter((r) => r.age >= i.retireAge),
    };
  }

  /* --------------------------------------------------------------- tooltip */
  const tip = $('#tooltip');
  function showTip(x, y, title, rows, total) {
    tip.replaceChildren();
    const h = document.createElement('div');
    h.className = 'tt-title'; h.textContent = title; tip.appendChild(h);
    for (const r of rows) {
      const line = document.createElement('div'); line.className = 'tt-row';
      const key = document.createElement('span'); key.className = 'tt-key'; key.style.background = r.color;
      const val = document.createElement('span'); val.className = 'tt-val'; val.textContent = r.value;
      const name = document.createElement('span'); name.className = 'tt-name'; name.textContent = r.name;
      line.append(key, val, name); tip.appendChild(line);
    }
    if (total) {
      const tt = document.createElement('div'); tt.className = 'tt-total';
      const l = document.createElement('span'); l.textContent = total.name;
      const v = document.createElement('strong'); v.textContent = total.value;
      tt.append(l, v); tip.appendChild(tt);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, hgt = tip.offsetHeight, pad = 16;
    let left = x + pad, top = y - hgt / 2;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    top = Math.max(8, Math.min(window.innerHeight - hgt - 8, top));
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${top}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  /* ---------------------------------------------------------- chart basics */
  function frame(container, margin = { top: 16, right: 20, bottom: 32, left: 56 }) {
    container.replaceChildren();
    const W = Math.max(280, container.clientWidth), H = Math.max(200, container.clientHeight);
    const svg = d3.select(container).append('svg').attr('width', W).attr('height', H).attr('role', 'img');
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    return { svg, g, w: W - margin.left - margin.right, h: H - margin.top - margin.bottom, margin, W, H };
  }

  function axes(g, x, y, w, h, { xTicks, yTicks = 5 } = {}) {
    g.append('g').attr('class', 'grid')
      .call(d3.axisLeft(y).ticks(yTicks).tickSize(-w).tickFormat(''));
    g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(yTicks).tickSize(0).tickPadding(10).tickFormat(axisFmt));
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(xTicks ?? Math.min(10, Math.floor(w / 70))).tickSize(0).tickPadding(12).tickFormat((d) => (Number.isInteger(d) ? d : '')));
    g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', w).attr('y1', y(0)).attr('y2', y(0));
  }

  function legend(el, items) {
    el.replaceChildren();
    for (const it of items) {
      const s = document.createElement('span'); s.className = 'legend-item';
      const k = document.createElement('span'); k.className = `legend-key ${it.type || ''}`; k.style.background = it.color;
      const t = document.createElement('span'); t.textContent = it.name;
      s.append(k, t); el.appendChild(s);
    }
  }

  /** Crosshair + keyboard-scrubbable hover layer for age-indexed charts. */
  function crosshair({ g, x, w, h, ages, onAge, maxAge = () => Infinity, label }) {
    const line = g.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', h).style('opacity', 0);
    const dots = g.append('g');
    const overlay = g.append('rect').attr('class', 'overlay').attr('width', w).attr('height', h)
      .attr('tabindex', 0).attr('aria-label', label);
    let current = null;
    const show = (age, cx, cy) => {
      age = Math.max(ages[0], Math.min(ages[ages.length - 1], Math.min(maxAge(), age)));
      current = age;
      line.attr('x1', x(age)).attr('x2', x(age)).style('opacity', 1);
      dots.selectAll('*').remove();
      onAge(age, dots, cx, cy);
    };
    const hide = () => { line.style('opacity', 0); dots.selectAll('*').remove(); hideTip(); current = null; };
    overlay
      .on('pointermove', (ev) => { const [mx] = d3.pointer(ev); show(Math.round(x.invert(mx)), ev.clientX, ev.clientY); })
      .on('pointerleave', hide)
      .on('focus', function () {
        const b = this.getBoundingClientRect();
        const age = current ?? Math.min(maxAge(), ages[Math.floor(ages.length / 2)]);
        show(age, b.left + x(age), b.top + h / 3);
      })
      .on('blur', hide)
      .on('keydown', function (ev) {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const b = this.getBoundingClientRect();
        const age = (current ?? ages[0]) + (ev.key === 'ArrowRight' ? 1 : -1);
        show(age, b.left + x(Math.max(ages[0], Math.min(ages[ages.length - 1], age))), b.top + h / 3);
      });
  }

  function stackedTooltip(r, cx, cy, keys, withOther) {
    const series = (withOther ? [OTHER, ...[...keys].reverse()] : [...keys].reverse());
    showTip(cx, cy, `Age ${r.age} · ${r.year}`,
      series.map((s) => ({ color: s.color, name: s.name, value: fmt(u(r[s.key], r)) })),
      { name: withOther ? 'Net worth' : 'Invested', value: fmt(u(withOther ? r.netWorth : r.invested, r)) });
  }

  /* ------------------------------------------------------- journey (signature) */
  let journey = null;

  function renderJourney() {
    const sim = state.sim;
    const el = $('#journey-chart');
    const rows = sim.rows;
    legend($('#journey-legend'), [...ACCOUNTS, OTHER]);
    const narrow = el.clientWidth < 560;
    const f = frame(el, { top: 16, right: narrow ? 12 : 120, bottom: 32, left: 56 });
    const { g, w, h } = f;
    f.svg.attr('aria-label', 'Stacked area chart of net worth by account from today to the end of the plan.');

    const keys = [...ACCOUNTS.map((a) => a.key), 'other'];
    // Diverging offset lets negative "other assets" (debt) sit below zero; exact zeros would collapse to the baseline, so nudge them.
    const pos = (v) => (v === 0 ? 1e-9 : v);
    const data = rows.map((r) => ({ age: r.age, roth: pos(u(r.roth, r)), trad: pos(u(r.trad, r)), taxable: pos(u(r.taxable, r)), other: pos(u(r.other, r)) }));
    const stack = d3.stack().keys(keys).offset(d3.stackOffsetDiverging)(data);
    const x = d3.scaleLinear().domain([rows[0].age, rows[rows.length - 1].age]).range([0, w]);
    const yMin = Math.min(0, d3.min(stack, (s) => d3.min(s, (d) => d[0])));
    const yMax = d3.max(stack, (s) => d3.max(s, (d) => d[1])) || 1;
    const y = d3.scaleLinear().domain([yMin, yMax * 1.06]).nice().range([h, 0]);
    axes(g, x, y, w, h);

    const clipId = `clip-journey`;
    const clipRect = f.svg.append('defs').append('clipPath').attr('id', clipId).append('rect')
      .attr('x', -2).attr('y', -20).attr('height', h + 40).attr('width', 0);
    const plot = g.append('g').attr('clip-path', `url(#${clipId})`);
    const colorOf = (k) => (k === 'other' ? OTHER.color : ACCOUNTS.find((a) => a.key === k).color);
    const area = d3.area().x((d) => x(d.data.age)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
    plot.selectAll('path.area-seg').data(stack).join('path').attr('class', 'area-seg')
      .attr('d', area).style('fill', (s) => colorOf(s.key));

    // Retirement marker
    const ra = sim.inputs.retireAge;
    if (ra > rows[0].age && ra < rows[rows.length - 1].age) {
      plot.append('line').attr('class', 'marker-line').attr('x1', x(ra)).attr('x2', x(ra)).attr('y1', 0).attr('y2', h);
      const flip = x(ra) > w * 0.7;
      plot.append('text').attr('class', 'marker-label').attr('x', x(ra) + (flip ? -6 : 6)).attr('text-anchor', flip ? 'end' : 'start').attr('y', 10).text(`RETIRE · ${ra}`);
    }
    // Expense event dots on the net-worth line
    const evRows = rows.filter((r) => r.events.length);
    plot.selectAll('circle.event-dot').data(evRows).join('circle').attr('class', 'event-dot')
      .attr('r', 5).attr('cx', (r) => x(r.age)).attr('cy', (r) => y(Math.max(0, u(r.invested, r)) + Math.max(0, u(r.other, r))));

    // Direct labels at the right edge (revealed when the scrub reaches the end)
    if (!narrow) {
      const last = stack.map((s) => ({ key: s.key, d: s[s.length - 1] }));
      const labels = plot.append('g');
      last.forEach(({ key, d }) => {
        const band = Math.abs(y(d[0]) - y(d[1]));
        if (band < 16) return;
        const name = key === 'other' ? OTHER.name : ACCOUNTS.find((a) => a.key === key).name;
        const t = labels.append('text').attr('class', 'direct-label').attr('x', w + 8).attr('y', (y(d[0]) + y(d[1])) / 2 + 4);
        t.text(name);
      });
      f.svg.select(`#${clipId} rect`).attr('height', h + 40);
    }

    // Moving "now" edge
    const edge = g.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', h).style('opacity', 0);
    const edgeDot = g.append('circle').attr('class', 'hover-dot').attr('r', 6).style('fill', 'var(--ink)').style('opacity', 0);

    const nwAt = (age) => {
      const i0 = Math.max(0, Math.min(rows.length - 1, Math.floor(age - rows[0].age)));
      const i1 = Math.min(rows.length - 1, i0 + 1);
      const t = age - rows[i0].age;
      const a = u(rows[i0].netWorth, rows[i0]), b = u(rows[i1].netWorth, rows[i1]);
      return a + (b - a) * t;
    };
    const topAt = (age) => {
      const idx = Math.max(0, Math.min(rows.length - 1, Math.round(age - rows[0].age)));
      return d3.max(stack, (s) => s[idx][1]);
    };

    crosshair({
      g, x, w, h, ages: rows.map((r) => r.age), label: 'Net worth by age. Use left and right arrow keys to move through years.',
      maxAge: () => journey.revealAge,
      onAge: (age, dots, cx, cy) => {
        const r = rows[age - rows[0].age];
        dots.append('circle').attr('class', 'hover-dot').attr('r', 5).attr('cx', x(age)).attr('cy', y(topAt(age))).style('fill', 'var(--ink)');
        stackedTooltip(r, cx, cy, ACCOUNTS, true);
      },
    });

    // Caption events (ordered by age)
    const i = sim.inputs;
    const events = [{ age: rows[0].age, chip: 'Today', text: `You start with ${fmt(rows[0].netWorth)} in net worth, ${fmt(rows[0].invested)} of it invested.` }];
    evRows.forEach((r) => r.events.forEach((e) => events.push({
      age: r.age, chip: `Age ${r.age}`,
      text: `${e.label}: ${fmt(u(e.cost, r))} comes out of savings${e.shortfall > 0.5 ? `, with ${fmt(u(e.shortfall, r))} left unfunded` : ''}.`,
    })));
    if (sim.crossRow) events.push({ age: sim.crossRow.age, chip: `Age ${sim.crossRow.age}`, text: 'Market growth now adds more each year than your own contributions.' });
    const millionRow = rows.find((r) => u(r.invested, r) >= 1e6);
    if (millionRow && millionRow.age > rows[0].age) events.push({ age: millionRow.age, chip: `Age ${millionRow.age}`, text: 'Your investments pass $1 million.' });
    if (sim.fiRow && sim.fiRow.age > rows[0].age) events.push({ age: sim.fiRow.age, chip: `Age ${sim.fiRow.age}`, text: `Financially independent: at a ${i.swr}% withdrawal rate, savings could cover your spending.` });
    if (i.retireAge > rows[0].age) events.push({ age: i.retireAge, chip: `Age ${i.retireAge}`, text: `You retire with ${fmt(u(sim.retireRow.invested, sim.retireRow))} invested.` });
    if (sim.depleteRow) events.push({ age: sim.depleteRow.age, chip: `Age ${sim.depleteRow.age}`, text: 'Savings run out. Spending from here would have to come from other income.' });
    else events.push({ age: sim.endRow.age, chip: `Age ${sim.endRow.age}`, text: `The plan ends with ${fmt(u(sim.endRow.netWorth, sim.endRow))} in net worth.` });
    events.sort((a, b) => a.age - b.age);

    journey = { x, y, w, h, rows, clipRect, edge, edgeDot, nwAt, topAt, events, revealAge: rows[0].age, lastCaption: null };
    updateJourney(state.journeyProgress);
  }

  function updateJourney(p) {
    if (!journey) return;
    const { x, y, w, rows, clipRect, edge, edgeDot, nwAt, topAt, events } = journey;
    const a0 = rows[0].age, a1 = rows[rows.length - 1].age;
    const age = a0 + (a1 - a0) * p;
    journey.revealAge = Math.floor(age + 1e-6);
    clipRect.attr('width', p >= 0.999 ? w + 200 : x(age) + 2);
    const showEdge = p > 0.002 && p < 0.999;
    edge.attr('x1', x(age)).attr('x2', x(age)).style('opacity', showEdge ? 1 : 0);
    const iLo = Math.floor(age - a0), tt = age - a0 - iLo;
    const top = iLo >= rows.length - 1 ? topAt(a1) : topAt(a0 + iLo) + (topAt(a0 + iLo + 1) - topAt(a0 + iLo)) * tt;
    edgeDot.attr('cx', x(age)).attr('cy', y(top)).style('opacity', showEdge ? 1 : 0);

    $('#journey-age').textContent = Math.floor(age + 1e-6);
    $('#journey-total').textContent = `${fmt(nwAt(age))} net worth`;

    const ev = [...events].reverse().find((e) => e.age <= age + 1e-6) || events[0];
    if (ev !== journey.lastCaption) {
      journey.lastCaption = ev;
      const cap = $('#journey-caption');
      cap.replaceChildren();
      const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = ev.chip;
      const txt = document.createElement('span'); txt.className = 'caption-text'; txt.textContent = ev.text;
      cap.append(chip, txt);
    }
  }

  function journeyProgressFromScroll() {
    const sec = $('#journey');
    const sticky = $('.journey-sticky');
    const rect = sec.getBoundingClientRect();
    const topbar = $('.topbar').offsetHeight;
    const dist = sec.offsetHeight - sticky.offsetHeight;
    if (dist <= 0) return 1;
    return Math.max(0, Math.min(1, (topbar - rect.top) / dist));
  }

  /* --------------------------------------------------------- growth engine */
  function renderEngine() {
    const sim = state.sim;
    const rows = sim.workRows;
    const panel = $('#engine-chart').closest('.panel');
    if (rows.length < 2) { panel.hidden = true; return; }
    panel.hidden = false;

    const el = $('#engine-chart');
    const narrow = el.clientWidth < 560;
    const f = frame(el, { top: 16, right: narrow ? 12 : 120, bottom: 32, left: 56 });
    const { g, w, h } = f;
    f.svg.attr('aria-label', 'Line chart comparing yearly contributions with yearly market growth during working years.');
    const series = [
      { key: 'contrib', name: 'Your contributions', color: 'var(--saved)' },
      { key: 'growth', name: 'Market growth', color: 'var(--growth)' },
    ];
    const x = d3.scaleLinear().domain(d3.extent(rows, (r) => r.age)).range([0, w]);
    const yMax = d3.max(rows, (r) => Math.max(u(r.contrib, r), u(r.growth, r))) || 1;
    const yMin = Math.min(0, d3.min(rows, (r) => u(r.growth, r)));
    const y = d3.scaleLinear().domain([yMin, yMax * 1.08]).nice().range([h, 0]);
    axes(g, x, y, w, h);

    // Soft fill for the "gap" once growth leads
    const gapArea = d3.area().x((r) => x(r.age)).y0((r) => y(u(r.contrib, r))).y1((r) => y(Math.max(u(r.contrib, r), u(r.growth, r)))).curve(d3.curveMonotoneX);
    g.append('path').attr('d', gapArea(rows)).style('fill', 'var(--growth)').style('opacity', 0.1);

    const lines = series.map((s) => {
      const line = d3.line().x((r) => x(r.age)).y((r) => y(u(r[s.key], r))).curve(d3.curveMonotoneX);
      return g.append('path').attr('class', 'series-line draw-line').attr('d', line(rows)).style('stroke', s.color);
    });

    const cr = sim.crossRow;
    if (cr) {
      g.append('line').attr('class', 'marker-line').attr('x1', x(cr.age)).attr('x2', x(cr.age)).attr('y1', 0).attr('y2', h);
      g.append('text').attr('class', 'marker-label').attr('x', x(cr.age) + 6).attr('y', 10).text(`CROSSOVER · ${cr.age}`);
    }
    if (!narrow) {
      const last = rows[rows.length - 1];
      const ys = series.map((s) => ({ s, y: y(u(last[s.key], last)) }));
      if (Math.abs(ys[0].y - ys[1].y) < 16) { const mid = (ys[0].y + ys[1].y) / 2; ys.sort((a, b) => a.y - b.y); ys[0].y = mid - 9; ys[1].y = mid + 9; }
      ys.forEach(({ s, y: yy }) => g.append('text').attr('class', 'direct-label').attr('x', w + 8).attr('y', yy + 4).text(s.key === 'contrib' ? 'Contributions' : 'Growth'));
    }

    crosshair({
      g, x, w, h, ages: rows.map((r) => r.age), label: 'Contributions and growth by age. Use arrow keys to move through years.',
      onAge: (age, dots, cx, cy) => {
        const r = rows[age - rows[0].age];
        series.forEach((s) => dots.append('circle').attr('class', 'hover-dot').attr('r', 5).attr('cx', x(age)).attr('cy', y(u(r[s.key], r))).style('fill', s.color));
        showTip(cx, cy, `Age ${r.age} · ${r.year}`, [...series].reverse().map((s) => ({ color: s.color, name: s.name, value: fmt(u(r[s.key], r)) })),
          { name: 'Added this year', value: fmt(u(r.contrib + r.growth, r)) });
      },
    });
    legend($('#engine-legend'), series.map((s) => ({ ...s, type: 'line' })));

    const growthShare = sim.growthToRetire / (sim.growthToRetire + sim.contribToRetire || 1);
    $('#engine-title').textContent = cr
      ? `From age ${cr.age}, your money out-earns you`
      : 'Your contributions do most of the work';
    $('#engine-sub').textContent = `Before retiring you put in ${fmt(sumU(rows, 'contrib'))} and the market adds ${fmt(sumU(rows, 'growth'))}. Growth makes up ${Math.round(growthShare * 100)}% of everything added.`;

    registerDraw('engine', panel, () => {
      lines.forEach((p, idx) => {
        const len = p.node().getTotalLength();
        p.attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
          .transition().delay(idx * 250).duration(1600).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
          .on('end', () => p.attr('stroke-dasharray', null));
      });
    });
  }

  const sumU = (rows, k) => rows.reduce((s, r) => s + u(r[k], r), 0);

  /* ---------------------------------------------------------- income bars */
  function renderIncome() {
    const sim = state.sim;
    const rows = sim.workRows;
    const panel = $('#income-chart').closest('.panel');
    if (rows.length < 1) { panel.hidden = true; return; }
    panel.hidden = false;
    const el = $('#income-chart');
    const f = frame(el, { top: 12, right: 8, bottom: 32, left: 56 });
    const { g, w, h } = f;
    f.svg.attr('aria-label', 'Bar chart of yearly income split into the amount saved and everything else.');
    const x = d3.scaleBand().domain(rows.map((r) => r.age)).range([0, w]).paddingInner(rows.length > 30 ? 0.12 : 0.22);
    const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => u(r.income, r)) * 1.08 || 1]).nice().range([h, 0]);
    g.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(''));
    g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(10).tickFormat(axisFmt));
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(w / 56)));
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(12).tickValues(rows.map((r) => r.age).filter((a, idx) => idx % every === 0)));

    const bw = x.bandwidth();
    const rad = Math.min(4, bw / 2);
    const groups = g.selectAll('g.bar-group').data(rows).join('g').attr('class', 'bar-group')
      .attr('tabindex', 0).attr('role', 'img')
      .attr('aria-label', (r) => `Age ${r.age}: income ${fmt(u(r.income, r))}, saved ${fmt(u(r.contrib, r))}`)
      .attr('transform', (r) => `translate(${x(r.age)},0)`);
    // Saved (anchored to baseline) + everything else, 2px surface gap between
    groups.append('rect').attr('class', 'bar bar-saved').attr('width', bw).style('fill', 'var(--saved)')
      .attr('y', h).attr('height', 0);
    groups.append('path').attr('class', 'bar bar-rest').style('fill', 'var(--spent)');
    groups.append('rect').attr('width', bw + 2).attr('x', -1).attr('y', 0).attr('height', h).style('fill', 'transparent');

    const place = (sel, k = 1) => {
      sel.select('.bar-saved').attr('y', (r) => y(u(r.contrib, r) * k)).attr('height', (r) => h - y(u(r.contrib, r) * k));
      sel.select('.bar-rest').attr('d', (r) => {
        const top = y(u(r.income, r) * k), bottom = y(u(r.contrib, r) * k) - 2;
        const hh = Math.max(0, bottom - top), rr = Math.min(rad, hh);
        return `M0,${bottom}V${top + rr}Q0,${top} ${rr},${top}H${bw - rr}Q${bw},${top} ${bw},${top + rr}V${bottom}Z`;
      });
    };
    place(groups, state.revealed.has('income') || reduceMotion ? 1 : 0.0001);

    const tipFor = (ev, r) => {
      const b = ev.currentTarget.getBoundingClientRect();
      const cx = ev.clientX ?? b.left + b.width / 2, cy = ev.clientY ?? b.top + b.height / 3;
      showTip(cx, cy, `Age ${r.age} · ${r.year}`, [
        { color: 'var(--spent)', name: 'Spent, taxes, everything else', value: fmt(u(r.income - r.contrib, r)) },
        { color: 'var(--saved)', name: 'Saved', value: fmt(u(r.contrib, r)) },
      ], { name: 'Income', value: fmt(u(r.income, r)) });
    };
    groups.on('pointermove', tipFor).on('pointerleave', hideTip)
      .on('focus', (ev, r) => tipFor({ currentTarget: ev.currentTarget }, r)).on('blur', hideTip);

    legend($('#income-legend'), [{ name: 'Saved', color: 'var(--saved)' }, { name: 'Spent, taxes, everything else', color: 'var(--spent)' }]);
    const first = rows[0], last = rows[rows.length - 1];
    $('#income-sub').textContent = `Income grows from ${fmt(u(first.income, first))} to ${fmt(u(last.income, last))} a year. You save ${fmt(sumU(rows, 'contrib'))} in total.`;

    registerDraw('income', panel, () => {
      groups.transition().delay((r, idx) => idx * 18).duration(700).ease(d3.easeCubicOut)
        .tween('grow', function () { const sel = d3.select(this); return (t) => place(sel, Math.max(0.0001, t)); });
    });
  }

  /* ------------------------------------------------------------------ mix */
  function renderMix() {
    const r = state.sim.retireRow;
    const el = $('#mix');
    el.replaceChildren();
    const total = Math.max(1, r.roth + r.trad + r.taxable);
    const notes = {
      roth: 'Withdrawals are tax-free',
      trad: `Taxed as income when withdrawn (${state.inputs.taxRate}% here)`,
      taxable: 'Access any time; only gains are taxed',
    };
    const bar = document.createElement('div'); bar.className = 'mix-bar'; bar.setAttribute('aria-hidden', 'true');
    ACCOUNTS.forEach((a) => {
      const s = document.createElement('span');
      s.style.background = a.color; s.style.flex = `${r[a.key] / total} 1 0`;
      bar.appendChild(s);
    });
    const list = document.createElement('div'); list.className = 'mix-rows';
    ACCOUNTS.forEach((a) => {
      const row = document.createElement('div'); row.className = 'mix-row';
      const k = document.createElement('span'); k.className = 'legend-key'; k.style.background = a.color;
      const name = document.createElement('b'); name.textContent = a.name;
      const val = document.createElement('span'); val.className = 'mono'; val.textContent = fmt(u(r[a.key], r));
      const note = document.createElement('small'); note.textContent = notes[a.key];
      const pct = document.createElement('span'); pct.className = 'mix-pct'; pct.textContent = `${Math.round((r[a.key] / total) * 100)}%`;
      row.append(k, name, val, note, pct);
      list.appendChild(row);
    });
    el.append(bar, list);
    const panel = el.closest('.panel');
    $('#mix-title').textContent = `How your ${fmt(u(r.invested, r))} is taxed`;
    if (state.revealed.has('mix') || reduceMotion) el.classList.add('is-in');
    registerDraw('mix', panel, () => requestAnimationFrame(() => el.classList.add('is-in')));
  }

  /* ------------------------------------------------------------ drawdown */
  function renderDraw() {
    const sim = state.sim;
    const rows = sim.retireRows;
    const panel = $('#draw-chart').closest('.panel');
    if (rows.length < 2) { panel.hidden = true; return; }
    panel.hidden = false;
    const el = $('#draw-chart');
    const narrow = el.clientWidth < 560;
    const f = frame(el, { top: 16, right: narrow ? 12 : 120, bottom: 32, left: 56 });
    const { g, w, h } = f;
    f.svg.attr('aria-label', 'Stacked area chart of invested balances by account during retirement.');
    const keys = ACCOUNTS.map((a) => a.key);
    const data = rows.map((r) => ({ age: r.age, roth: u(r.roth, r), trad: u(r.trad, r), taxable: u(r.taxable, r) }));
    const stack = d3.stack().keys(keys)(data);
    const x = d3.scaleLinear().domain(d3.extent(rows, (r) => r.age)).range([0, w]);
    const y = d3.scaleLinear().domain([0, (d3.max(stack[stack.length - 1], (d) => d[1]) || 1) * 1.08]).nice().range([h, 0]);
    axes(g, x, y, w, h);
    const clipId = 'clip-draw';
    const clipRect = f.svg.append('defs').append('clipPath').attr('id', clipId).append('rect')
      .attr('x', -2).attr('y', -20).attr('height', h + 40)
      .attr('width', state.revealed.has('draw') || reduceMotion ? w + 200 : 0);
    const plot = g.append('g').attr('clip-path', `url(#${clipId})`);
    const area = d3.area().x((d) => x(d.data.age)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
    plot.selectAll('path').data(stack).join('path').attr('class', 'area-seg').attr('d', area)
      .style('fill', (s) => ACCOUNTS.find((a) => a.key === s.key).color);

    // Spending line (same dollars, same axis) — what you withdraw each year
    const spend = d3.line().x((r) => x(r.age)).y((r) => y(u(r.spending + r.expenseCost, r))).curve(d3.curveMonotoneX);
    plot.append('path').attr('class', 'series-line').attr('d', spend(rows)).style('stroke', 'var(--ink)').attr('stroke-dasharray', '5 4');

    if (sim.depleteRow) {
      const d = sim.depleteRow.age;
      plot.append('line').attr('class', 'marker-line').attr('x1', x(d)).attr('x2', x(d)).attr('y1', 0).attr('y2', h);
      plot.append('text').attr('class', 'marker-label').attr('x', x(d) - 6).attr('y', 10).attr('text-anchor', 'end').text(`RUNS OUT · ${d}`);
    }
    if (!narrow) {
      const labels = plot.append('g');
      const k = Math.min(2, rows.length - 1);
      stack.forEach((s) => {
        const d = s[k], key = s.key;
        if (Math.abs(y(d[0]) - y(d[1])) < 20) return;
        labels.append('text').attr('class', 'direct-label').attr('x', 8).attr('y', (y(d[0]) + y(d[1])) / 2 + 4)
          .style('fill', '#fff').style('font-weight', 600).text(ACCOUNTS.find((a) => a.key === key).name);
      });
      const lastR = rows[rows.length - 1];
      plot.append('text').attr('class', 'direct-label').attr('x', w + 8).attr('y', y(u(lastR.spending, lastR)) + 4).text('Spending');
    }

    crosshair({
      g, x, w, h, ages: rows.map((r) => r.age), label: 'Retirement balances by age. Use arrow keys to move through years.',
      onAge: (age, dots, cx, cy) => {
        const r = rows[age - rows[0].age];
        dots.append('circle').attr('class', 'hover-dot').attr('r', 5).attr('cx', x(age)).attr('cy', y(u(r.invested, r))).style('fill', 'var(--ink)');
        const lines = [...ACCOUNTS].reverse().map((s) => ({ color: s.color, name: s.name, value: fmt(u(r[s.key], r)) }));
        lines.push({ color: 'var(--ink)', name: 'Withdrawn for spending', value: fmt(u(r.spending + r.expenseCost - r.shortfall, r)) });
        if (r.shortfall > 0.5) lines.push({ color: 'var(--warn)', name: 'Not covered by savings', value: fmt(u(r.shortfall, r)) });
        showTip(cx, cy, `Age ${r.age} · ${r.year}`, lines, { name: 'Invested', value: fmt(u(r.invested, r)) });
      },
    });
    legend($('#draw-legend'), [...ACCOUNTS, { name: 'Yearly spending', color: 'transparent', type: 'dash' }]);

    const i = sim.inputs;
    $('#draw-title').textContent = sim.depleteRow
      ? `Your savings run out at ${sim.depleteRow.age}`
      : `Your savings last past ${i.planAge}`;
    $('#draw-sub').textContent = `Spending ${fmt(state.units === 'real' ? i.spending : i.spending * rows[0].deflator)} a year${state.units === 'real' ? " in today's dollars" : ' at first, rising with inflation'}. Withdrawals come from taxable first, then traditional, then Roth, so tax-free money grows the longest.`;

    registerDraw('draw', panel, () => {
      clipRect.transition().duration(1800).ease(d3.easeCubicInOut).attr('width', w + 200);
    });
  }

  /* ----------------------------------------------------------- milestones */
  function renderTimeline() {
    const sim = state.sim, i = sim.inputs, rows = sim.rows;
    const items = [];
    const first = rows[0];
    for (const m of [100e3, 250e3, 500e3, 1e6, 2e6, 5e6, 10e6]) {
      if (u(first.invested, first) >= m) continue;
      const r = rows.find((rr) => u(rr.invested, rr) >= m);
      if (r) items.push({ age: r.age, year: r.year, title: `${fmt(m).replace('.00', '')} invested`, body: `Across Roth, traditional, and taxable accounts${state.units === 'real' ? ", in today's dollars" : ''}.` });
    }
    if (sim.crossRow) items.push({ age: sim.crossRow.age, year: sim.crossRow.year, title: 'Growth passes contributions', body: `The market adds ${fmt(u(sim.crossRow.growth, sim.crossRow))} this year, more than the ${fmt(u(sim.crossRow.contrib, sim.crossRow))} you put in.` });
    if (sim.fiRow && sim.fiRow.age > first.age) items.push({ age: sim.fiRow.age, year: sim.fiRow.year, title: 'Financially independent', body: `A ${i.swr}% withdrawal from ${fmt(u(sim.fiRow.invested, sim.fiRow))} covers ${fmt(u(i.spending * sim.fiRow.deflator, sim.fiRow))} of yearly spending.` });
    rows.forEach((r) => r.events.forEach((e) => items.push({ age: r.age, year: r.year, title: e.label, body: `${fmt(u(e.cost, r))} paid from savings${e.shortfall > 0.5 ? `; ${fmt(u(e.shortfall, r))} couldn't be covered` : ''}.` })));
    if (i.retireAge > first.age) items.push({ age: i.retireAge, year: sim.retireRow.year, title: 'Retire', body: `${fmt(u(sim.retireRow.invested, sim.retireRow))} invested, ${fmt(u(sim.retireRow.netWorth, sim.retireRow))} net worth.` });
    if (sim.depleteRow) items.push({ age: sim.depleteRow.age, year: sim.depleteRow.year, title: 'Savings run out', body: 'From here, spending would need other income such as Social Security or a pension.' });
    items.push({ age: sim.endRow.age, year: sim.endRow.year, title: 'End of plan', body: `${fmt(u(sim.endRow.netWorth, sim.endRow))} net worth, including ${fmt(u(sim.endRow.invested, sim.endRow))} invested.` });
    items.sort((a, b) => a.age - b.age);

    const ol = $('#timeline');
    ol.replaceChildren();
    for (const it of items) {
      const li = document.createElement('li'); li.className = 'ms';
      const when = document.createElement('div'); when.className = 'ms-when';
      const b = document.createElement('b'); b.textContent = `Age ${it.age}`;
      when.append(b, document.createTextNode(String(it.year)));
      const h = document.createElement('h3'); h.className = 'ms-title'; h.textContent = it.title;
      const p = document.createElement('p'); p.className = 'ms-body'; p.textContent = it.body;
      li.append(when, h, p); ol.appendChild(li);
      if (reduceMotion) li.classList.add('is-in');
      else msObserver.observe(li);
    }
  }

  /* ---------------------------------------------------------------- table */
  function renderTable() {
    const t = $('#data-table');
    t.replaceChildren();
    const cols = [
      ['Age', (r) => r.age], ['Year', (r) => r.year],
      ['Income', (r) => fmtFull(u(r.income, r))], ['Saved', (r) => fmtFull(u(r.contrib, r))],
      ['Market growth', (r) => fmtFull(u(r.growth, r))], ['Withdrawn', (r) => fmtFull(u(r.withdrawn, r))],
      ['Roth', (r) => fmtFull(u(r.roth, r))], ['Traditional', (r) => fmtFull(u(r.trad, r))],
      ['Taxable', (r) => fmtFull(u(r.taxable, r))], ['Other assets', (r) => fmtFull(u(r.other, r))],
      ['Net worth', (r) => fmtFull(u(r.netWorth, r))],
    ];
    const thead = t.createTHead().insertRow();
    cols.forEach(([name]) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = name; thead.appendChild(th); });
    const tb = t.createTBody();
    state.sim.rows.forEach((r) => {
      const tr = tb.insertRow();
      if (r.age === state.inputs.retireAge) tr.className = 'is-retire';
      cols.forEach(([, fn]) => { tr.insertCell().textContent = fn(r); });
    });
  }

  /* -------------------------------------------------------------- verdict */
  function renderVerdict() {
    const sim = state.sim, i = sim.inputs, rr = sim.retireRow;
    const years = i.retireAge - i.age;
    $('#verdict-eyebrow').textContent = years > 0 ? `Retiring in ${years} year${years === 1 ? '' : 's'}` : 'Already retired';
    const h = $('#verdict-title');
    h.replaceChildren();
    const num = document.createElement('span'); num.className = 'num'; num.textContent = fmt(u(rr.invested, rr));
    h.append(document.createTextNode(years > 0 ? `At ${i.retireAge}, you’d have ` : 'You have '), num, document.createTextNode(' invested.'));

    const facts = $('#verdict-facts');
    facts.replaceChildren();
    const ok = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
    const no = '<path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9"/>';
    const add = (value, label, status) => {
      const d = document.createElement('div'); d.className = 'fact';
      const v = document.createElement('div'); v.className = 'fact-value'; v.textContent = value;
      const l = document.createElement('div'); l.className = 'fact-label'; l.textContent = label;
      d.append(v, l);
      if (status) {
        const s = document.createElement('div'); s.className = `fact-status ${status.good ? 'good' : 'bad'}`;
        s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${status.good ? ok : no}</svg>`;
        s.appendChild(document.createTextNode(status.text));
        d.appendChild(s);
      }
      facts.appendChild(d);
    };
    const fi = sim.fiRow;
    add(fi ? `Age ${fi.age}` : 'Not reached',
      `Financial independence: when a ${i.swr}% withdrawal covers your spending`,
      fi ? { good: fi.age <= i.retireAge, text: fi.age === i.retireAge ? 'Right as you retire' : fi.age < i.retireAge ? `${yrs(i.retireAge - fi.age)} before retiring` : `${yrs(fi.age - i.retireAge)} after retiring` } : { good: false, text: 'Save more or spend less' });
    add(sim.depleteRow ? `Age ${sim.depleteRow.age}` : `Past ${i.planAge}`,
      sim.depleteRow ? 'Savings run out before your plan ends' : 'Savings last through your whole plan',
      sim.depleteRow ? { good: false, text: `${yrs(i.planAge - sim.depleteRow.age)} short` } : { good: true, text: `${fmt(u(sim.endRow.invested, sim.endRow))} left over` });
    add(fmt(sumU(sim.workRows, 'contrib')), 'You contribute before retiring');
    add(fmt(sumU(sim.workRows, 'growth')), 'The market adds before retiring');
  }

  /* ------------------------------------------------------ reveal plumbing */
  const drawHooks = new Map();
  function registerDraw(id, panel, fn) {
    if (state.revealed.has(id) || reduceMotion) return;
    drawHooks.set(id, fn);
    panel.dataset.draw = id;
    drawObserver.observe(panel);
  }
  const drawObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.draw;
      const fn = drawHooks.get(id);
      if (fn && !state.revealed.has(id)) { state.revealed.add(id); fn(); }
      drawObserver.unobserve(e.target);
    }
  }, { threshold: 0.35 });

  const revealObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); revealObserver.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

  const msObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); msObserver.unobserve(e.target); }
  }, { rootMargin: '0px 0px -30% 0px' });

  const yrs = (n) => `${n} yr${n === 1 ? '' : 's'}`;

  /* ------------------------------------------------------------ rendering */
  function renderAll() {
    renderVerdict();
    renderJourney();
    renderEngine();
    renderIncome();
    renderMix();
    renderDraw();
    renderTimeline();
    renderTable();
  }
  function renderCharts() {
    if (!state.sim) return;
    renderJourney(); renderEngine(); renderIncome(); renderDraw();
  }

  function onScroll() {
    const doc = document.documentElement;
    const p = doc.scrollTop / Math.max(1, doc.scrollHeight - doc.clientHeight);
    $('.scroll-progress span').style.transform = `scaleX(${p})`;
    $('.topbar').classList.toggle('is-scrolled', doc.scrollTop > 8);
    if (!state.sim) return;
    const jp = journeyProgressFromScroll();
    if (Math.abs(jp - state.journeyProgress) > 1e-4) { state.journeyProgress = jp; updateJourney(jp); }
    const tl = $('#timeline');
    const r = tl.getBoundingClientRect();
    const tp = Math.max(0, Math.min(1, (window.innerHeight * 0.7 - r.top) / Math.max(1, r.height)));
    tl.style.setProperty('--tl-progress', tp);
  }

  /* --------------------------------------------------------------- wiring */
  function build(scroll = true) {
    const inputs = readForm();
    const err = validate(inputs);
    const errEl = $('#form-error');
    if (err) { errEl.textContent = err; errEl.hidden = false; errEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    errEl.hidden = true;
    store.set(STORAGE_KEY, JSON.stringify(inputs));
    state.inputs = inputs;
    state.sim = simulate(inputs);
    state.revealed.clear();
    drawHooks.clear();
    const results = $('#results');
    results.hidden = false;
    document.body.classList.add('has-results');
    $$('.reveal', results).forEach((el) => {
      if (reduceMotion) { el.classList.add('is-in'); return; }
      el.classList.remove('is-in'); revealObserver.observe(el);
    });
    state.journeyProgress = 0;
    renderAll();
    onScroll();
    if (scroll) requestAnimationFrame(() => results.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }));
  }

  function init() {
    let saved = null;
    try { saved = JSON.parse(store.get(STORAGE_KEY) || 'null'); } catch { saved = null; }
    fillForm(saved && typeof saved === 'object' ? { ...DEFAULTS, ...saved } : DEFAULTS);

    form.addEventListener('input', updateLiveHints);
    form.addEventListener('focusout', (e) => {
      if (e.target.matches('[data-money]')) {
        const n = parseMoney(e.target.value);
        if (Number.isFinite(n)) e.target.value = withCommas(n);
      }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); build(); });
    $('#add-expense').addEventListener('click', () => {
      const row = expenseRow({ label: '', age: (parseInt(form.elements.age.value, 10) || 30) + 5, amount: '' });
      $('#expenses').appendChild(row);
      toggleEmptyExpenses();
      $('[data-exp="label"]', row).focus();
    });
    $('#reset-form').addEventListener('click', () => { fillForm(DEFAULTS); $('#form-error').hidden = true; $$('.input.is-invalid').forEach((el) => el.classList.remove('is-invalid')); });
    $('#edit-numbers').addEventListener('click', () => $('#inputs').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }));

    $$('.segmented button').forEach((b) => b.addEventListener('click', () => {
      state.units = b.dataset.units;
      $$('.segmented button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      if (state.sim) renderAll();
    }));

    // Theme toggle: OS preference by default, explicit choice wins.
    const root = document.documentElement;
    const savedTheme = store.get(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;
    else root.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    $('.theme-toggle').addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      store.set(THEME_KEY, root.dataset.theme);
    });

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => { ticking = false; onScroll(); });
    }, { passive: true });
    let lastW = window.innerWidth, rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        // Mobile browsers fire resize when the URL bar hides; only redraw on real layout changes.
        if (window.innerWidth === lastW && state.sim && Math.abs(window.innerHeight - (renderCharts.h || 0)) < 120) return;
        lastW = window.innerWidth; renderCharts.h = window.innerHeight;
        renderCharts(); onScroll();
      }, 150);
    });
    renderCharts.h = window.innerHeight;
    onScroll();
  }

  if (window.d3) init();
  else window.addEventListener('load', () => {
    if (window.d3) init();
    else { const e = $('#form-error'); e.textContent = 'The charting library didn’t load. Check your connection and refresh the page.'; e.hidden = false; }
  });
})();
