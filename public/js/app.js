/* ============================================================
   app.js
   Top-level glue: file loading, schema browser, filter <-> SQL
   sync, query execution, results table.
   ============================================================ */
(function () {
  'use strict';

  // ---------- DOM refs -------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fileInput     = $('file-input');
  const resetBtn      = $('reset-btn');
  const dropzone      = $('dropzone');
  const querySection  = $('query-section');
  const tableList     = $('table-list');
  const tableCount    = $('table-count');
  const columnsPanel  = $('columns-panel');
  const columnList    = $('column-list');
  const columnCount   = $('column-count');
  const activeTableSel = $('active-table');
  const filterHost    = $('filter-builder');
  const addCondBtn    = $('add-condition');
  const addOrBtn      = $('add-or');
  const clearFilterBtn = $('clear-filter');
  const sqlOutput     = $('sql-output');
  const toggleSqlEditBtn = $('toggle-sql-edit');
  const runBtn        = $('run-query');
  const resultMeta    = $('result-meta');
  const resultsHost   = $('results');
  const exportBtn     = $('export-csv');
  const columnChips   = $('column-chips');
  const colsSelectAll = $('cols-select-all');
  const viewTableBtn  = $('view-table');
  const viewCardsBtn  = $('view-cards');
  const langAllBtn    = $('lang-all');
  const langEnBtn     = $('lang-en');
  const langHeBtn     = $('lang-he');

  // ---------- state ----------------------------------------------------
  let activeTable = null;
  let manualSqlMode = false;
  let lastResult = null;       // last successful { columns, rows, ms }
  let selectedCols = [];       // columns user wants to display; [] means "all visible"
  let sortState = { col: null, dir: null }; // dir: 'asc' | 'desc' | null
  let viewMode = 'table';      // 'table' | 'cards'
  let languageFilter = 'all';  // 'all' | 'english' | 'hebrew'

  // ---------- query builder instance -----------------------------------
  const qb = new QueryBuilder(filterHost, { onChange: refreshSql });

  // ---------- file loading ---------------------------------------------
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await handleFiles(files);
    fileInput.value = '';
  });

  // drag-and-drop on the dropzone
  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); });
  });
  dropzone.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await handleFiles(files);
  });

  resetBtn.addEventListener('click', async () => {
    await DataDB.reset();
    activeTable = null;
    lastResult = null;
    selectedCols = [];
    sortState = { col: null, dir: null };
    languageFilter = 'all';
    langAllBtn.classList.add('active');
    langEnBtn.classList.remove('active');
    langHeBtn.classList.remove('active');
    qb.setColumns([]);
    refreshSchemaUI();
    renderColumnPicker();
    refreshSql();
    resultsHost.innerHTML = '<p class="empty-hint">No query run yet. Build a filter above and hit <strong>Run query</strong>.</p>';
    resultMeta.textContent = '';
    exportBtn.disabled = true;
    dropzone.hidden = false;
    querySection.hidden = true;
    toast('Cleared all data.', 'success');
  });

  async function handleFiles(files) {
    try {
      await DataDB.init();
    } catch (err) {
      return toast('Failed to initialise SQL engine: ' + err.message, 'error');
    }

    let totalLoaded = 0;
    for (const f of files) {
      try {
        const parsed = await DataParser.parseFile(f);
        if (parsed.sqliteBuffer) {
          // Loading a SQLite file replaces the whole DB.
          await DataDB.loadSqliteBuffer(parsed.sqliteBuffer);
          const tables = DataDB.listTables();
          totalLoaded += tables.length;
          toast(`Loaded SQLite database (${tables.length} table${tables.length !== 1 ? 's' : ''}).`, 'success');
        } else if (parsed.tables) {
          for (const t of parsed.tables) {
            await DataDB.createTableFromRows(t.name, t.columns, t.rows);
            totalLoaded++;
          }
          const names = parsed.tables.map((t) => t.name).join(', ');
          toast(`Loaded ${parsed.tables.length} table${parsed.tables.length !== 1 ? 's' : ''}: ${names}`, 'success');
        }
      } catch (err) {
        console.error(err);
        toast(`Failed to load ${f.name}: ${err.message}`, 'error');
      }
    }

    if (totalLoaded > 0) {
      dropzone.hidden = true;
      querySection.hidden = false;
      // Default to the first table if none selected.
      const tables = DataDB.listTables();
      if (!activeTable || !tables.includes(activeTable)) {
        activeTable = tables[0];
      }
      refreshSchemaUI();
      onActiveTableChanged();
    }
  }

  // ---------- schema sidebar -------------------------------------------
  function refreshSchemaUI() {
    const tables = DataDB.listTables();
    tableCount.textContent = tables.length;

    // Sidebar table list
    tableList.innerHTML = '';
    if (!tables.length) {
      tableList.innerHTML = '<p class="empty-hint">No data loaded yet. Click <strong>Load file</strong> to begin.</p>';
      columnsPanel.hidden = true;
      activeTableSel.innerHTML = '';
      return;
    }
    tables.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'table-item' + (t === activeTable ? ' active' : '');
      item.innerHTML = `
        <span class="table-item-name">
          <span class="table-item-icon">▦</span>
          <span>${escapeHtml(t)}</span>
        </span>
        <span class="table-item-rows">${DataDB.tableRowCount(t).toLocaleString()} rows</span>
      `;
      item.addEventListener('click', () => {
        activeTable = t;
        onActiveTableChanged();
      });
      tableList.appendChild(item);
    });

    // Top-of-panel <select> for active table
    activeTableSel.innerHTML = '';
    tables.forEach((t) => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (t === activeTable) o.selected = true;
      activeTableSel.appendChild(o);
    });

    // Column list for active table
    if (activeTable) {
      const cols = DataDB.schema(activeTable);
      columnsPanel.hidden = false;
      columnCount.textContent = cols.length;
      columnList.innerHTML = '';
      cols.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'column-item';
        el.innerHTML = `
          <span>${escapeHtml(c.name)}</span>
          <span class="column-type">${escapeHtml(c.type)}</span>
        `;
        columnList.appendChild(el);
      });
    } else {
      columnsPanel.hidden = true;
    }
  }

  activeTableSel.addEventListener('change', () => {
    activeTable = activeTableSel.value;
    onActiveTableChanged();
  });

  function onActiveTableChanged() {
    if (!activeTable) return;
    const cols = DataDB.schema(activeTable);
    qb.setColumns(visibleSchemaCols(cols));
    qb.clear();
    // When switching tables, default to "all visible columns".
    selectedCols = [];
    renderColumnPicker();
    refreshSchemaUI();
    refreshSql();
  }

  // ---------- filter <-> SQL sync --------------------------------------
  function refreshSql() {
    if (manualSqlMode) return; // user is editing manually; don't overwrite
    if (!activeTable) {
      sqlOutput.value = '';
      return;
    }
    const where = qb.buildWhere();
    const selectList = buildSelectList();
    const sql = `SELECT ${selectList} FROM ${DataDB.quoteIdent(activeTable)}${where ? '\n' + where : ''}\nLIMIT 1000;`;
    sqlOutput.value = sql;
  }

  // Build the comma-separated column list for SELECT. If the user hasn't
  // picked any columns, or has picked every visible column, emit "*".
  function buildSelectList() {
    if (!activeTable) return '*';
    const visible = visibleColumnNames();
    if (!visible.length) return '*';
    // No specific selection, or selection == every visible column -> use *
    if (!selectedCols.length || selectedCols.length === visible.length) {
      // When the language filter is active and hides some columns, we still
      // need to emit the explicit list so we don't accidentally SELECT the
      // hidden-language columns.
      if (languageFilter === 'all') return '*';
      return visible.map((c) => DataDB.quoteIdent(c)).join(', ');
    }
    return selectedCols.map((c) => DataDB.quoteIdent(c)).join(', ');
  }

  // ---------- language filter ------------------------------------------
  // A column is "visible" if it matches the current language filter.
  function matchesLanguage(colName) {
    const n = String(colName).toLowerCase();
    if (languageFilter === 'english') return !n.includes('hebrew');
    if (languageFilter === 'hebrew')  return !n.includes('english');
    return true;
  }
  function visibleColumnNames() {
    if (!activeTable) return [];
    return DataDB.schema(activeTable).map((c) => c.name).filter(matchesLanguage);
  }
  function visibleSchemaCols(schemaCols) {
    return schemaCols.filter((c) => matchesLanguage(c.name));
  }

  function setLanguage(lang) {
    languageFilter = lang;
    // Update button states
    [['all', langAllBtn], ['english', langEnBtn], ['hebrew', langHeBtn]].forEach(([k, btn]) => {
      const on = (k === lang);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!activeTable) return;
    // Reset column selection to "all visible" so the chips reflect the filter
    // (the user's previous custom selection is intentionally discarded — clicking
    // a language preset is itself a selection action).
    selectedCols = [];
    // Filter the conditions' field dropdown to visible columns; QB drops any
    // existing conditions referencing a now-hidden column.
    qb.setColumns(visibleSchemaCols(DataDB.schema(activeTable)));
    renderColumnPicker();
    refreshSql();
  }

  langAllBtn.addEventListener('click', () => setLanguage('all'));
  langEnBtn .addEventListener('click', () => setLanguage('english'));
  langHeBtn .addEventListener('click', () => setLanguage('hebrew'));

  // ---------- column picker --------------------------------------------
  function renderColumnPicker() {
    columnChips.innerHTML = '';
    if (!activeTable) return;
    const cols = visibleColumnNames();
    if (!cols.length) {
      const note = document.createElement('p');
      note.className = 'column-picker-empty';
      note.textContent = `No columns match the current language filter (${languageFilter}).`;
      columnChips.appendChild(note);
      return;
    }
    const selSet = new Set(selectedCols);
    const showingAll = selectedCols.length === 0 || selectedCols.length === cols.length;
    cols.forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isOn = showingAll || selSet.has(name);
      chip.className = 'col-chip' + (isOn ? ' on' : '');
      chip.textContent = name;
      chip.title = isOn ? 'Click to hide this column' : 'Click to show this column';
      chip.addEventListener('click', () => {
        // First click while "all" is implicit -> seed selection with everything then toggle.
        let next = selectedCols.length === 0 ? cols.slice() : selectedCols.slice();
        if (next.includes(name)) next = next.filter((c) => c !== name);
        else                     next.push(name);
        // Preserve schema order
        selectedCols = cols.filter((c) => next.includes(c));
        renderColumnPicker();
        refreshSql();
      });
      columnChips.appendChild(chip);
    });
  }

  colsSelectAll.addEventListener('click', () => {
    selectedCols = []; // empty == all visible
    renderColumnPicker();
    refreshSql();
  });

  addCondBtn.addEventListener('click', () => qb.addRow('AND'));
  addOrBtn.addEventListener('click',   () => qb.addRow('OR'));
  clearFilterBtn.addEventListener('click', () => qb.clear());

  toggleSqlEditBtn.addEventListener('click', () => {
    manualSqlMode = !manualSqlMode;
    if (manualSqlMode) {
      sqlOutput.removeAttribute('readonly');
      toggleSqlEditBtn.textContent = 'Sync from filter';
      sqlOutput.focus();
      toast('SQL is now editable. Filter changes won’t overwrite it.', 'success');
    } else {
      sqlOutput.setAttribute('readonly', 'readonly');
      toggleSqlEditBtn.textContent = 'Edit manually';
      refreshSql();
    }
  });

  // ---------- run query -------------------------------------------------
  runBtn.addEventListener('click', () => {
    const sql = sqlOutput.value.trim();
    if (!sql) {
      toast('Nothing to run.', 'error');
      return;
    }
    runBtn.classList.add('running');
    runBtn.disabled = true;
    // Defer one frame so the spinner actually paints before sql.js blocks.
    requestAnimationFrame(() => {
      try {
        const res = DataDB.run(sql);
        lastResult = res;
        sortState = { col: null, dir: null }; // fresh query -> unsorted
        renderResults();
        resultMeta.textContent = `${res.rowCount.toLocaleString()} row${res.rowCount !== 1 ? 's' : ''}` +
                                 (res.ms ? ` in ${res.ms.toFixed(1)}ms` : '');
        exportBtn.disabled = res.rowCount === 0;
      } catch (err) {
        lastResult = null;
        resultsHost.innerHTML = `<pre class="results-error">${escapeHtml(err.message)}</pre>`;
        resultMeta.textContent = 'Error';
        exportBtn.disabled = true;
      } finally {
        runBtn.classList.remove('running');
        runBtn.disabled = false;
      }
    });
  });

  // Cmd/Ctrl+Enter from the SQL textarea also runs.
  sqlOutput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runBtn.click();
    }
  });

  // ---------- results --------------------------------------------------
  function renderResults() {
    if (!lastResult) {
      resultsHost.innerHTML = '<p class="empty-hint">No query run yet. Build a filter above and hit <strong>Run query</strong>.</p>';
      return;
    }
    const res = lastResult;
    if (!res.columns.length) {
      resultsHost.innerHTML = '<p class="empty-hint">Statement executed — no result set returned.</p>';
      return;
    }
    if (!res.rows.length) {
      resultsHost.innerHTML = '<p class="empty-hint">No rows matched.</p>';
      return;
    }
    const rows = sortedRows(res);
    resultsHost.innerHTML = '';
    if (viewMode === 'cards') {
      resultsHost.appendChild(renderCards(res.columns, rows));
    } else {
      resultsHost.appendChild(renderTable(res.columns, rows));
    }
  }

  // Sort the latest result rows by the current sortState. We keep this
  // entirely client-side so toggling sort doesn't re-run the SQL.
  function sortedRows(res) {
    if (!sortState.col || !sortState.dir) return res.rows;
    const idx = res.columns.indexOf(sortState.col);
    if (idx < 0) return res.rows;
    const dir = sortState.dir === 'desc' ? -1 : 1;
    const copy = res.rows.slice();
    copy.sort((a, b) => compareCells(a[idx], b[idx]) * dir);
    return copy;
  }

  function compareCells(a, b) {
    // Nulls always sort last (regardless of direction feels less surprising).
    const aNull = a === null || a === undefined || a === '';
    const bNull = b === null || b === undefined || b === '';
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function renderTable(columns, rows) {
    const table = document.createElement('table');
    table.className = 'results-table';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    columns.forEach((c) => {
      const th = document.createElement('th');
      th.className = 'sortable';
      const isSorted = sortState.col === c;
      if (isSorted) th.classList.add('sorted-' + sortState.dir);

      const label = document.createElement('span');
      label.className = 'th-label';
      label.textContent = c;

      const indicator = document.createElement('span');
      indicator.className = 'sort-indicator';
      indicator.textContent = isSorted ? (sortState.dir === 'asc' ? '▲' : '▼') : '↕';

      th.append(label, indicator);
      th.title = 'Click to sort by ' + c;
      th.addEventListener('click', () => {
        // none -> asc -> desc -> none (cycle on same column)
        if (sortState.col !== c) { sortState = { col: c, dir: 'asc' }; }
        else if (sortState.dir === 'asc')  { sortState = { col: c, dir: 'desc' }; }
        else if (sortState.dir === 'desc') { sortState = { col: null, dir: null }; }
        else                                { sortState = { col: c, dir: 'asc' }; }
        renderResults();
      });
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      r.forEach((v) => {
        const td = document.createElement('td');
        if (v === null || v === undefined) {
          td.textContent = 'NULL';
          td.className = 'null';
        } else {
          td.textContent = String(v);
          td.title = String(v);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // Pick a "title-ish" column for cards: looks for names like title/name/
  // topic/subject; otherwise falls back to the first column.
  function pickTitleCol(columns) {
    const wanted = ['title', 'name', 'topic', 'subject', 'heading'];
    const lc = columns.map((c) => c.toLowerCase());
    for (const w of wanted) {
      const i = lc.findIndex((c) => c === w || c.endsWith('_' + w) || c.startsWith(w + '_'));
      if (i >= 0) return columns[i];
    }
    return columns[0];
  }

  // Pick a "date-ish" column for the card subtitle, if any.
  function pickDateCol(columns) {
    const lc = columns.map((c) => c.toLowerCase());
    const i = lc.findIndex((c) => c === 'date' || c.endsWith('_date') || c.startsWith('date_') || c.includes('date'));
    return i >= 0 ? columns[i] : null;
  }

  // Pick a "description-ish" column for the card body. Multiple synonyms
  // because real-world schemas vary a lot.
  function pickDescCol(columns) {
    const synonyms = ['description', 'desc', 'body', 'content', 'text',
                      'notes', 'note', 'summary', 'comment', 'comments',
                      'details', 'detail', 'excerpt', 'abstract', 'message'];
    const lc = columns.map((c) => c.toLowerCase());
    // Exact / suffix / prefix match first
    for (const w of synonyms) {
      const i = lc.findIndex((c) => c === w || c.endsWith('_' + w) || c.startsWith(w + '_'));
      if (i >= 0) return columns[i];
    }
    // Then any-position match (covers e.g. "description_english")
    for (const w of synonyms) {
      const i = lc.findIndex((c) => c.includes(w));
      if (i >= 0) return columns[i];
    }
    return null;
  }

  // Pick a "location-ish" column (Address, Location, Place, City, Country).
  function pickLocationCol(columns) {
    const synonyms = ['address', 'location', 'place', 'city', 'country', 'region'];
    const lc = columns.map((c) => c.toLowerCase());
    for (const w of synonyms) {
      const i = lc.findIndex((c) => c === w || c.includes(w));
      if (i >= 0) return columns[i];
    }
    return null;
  }

  function renderCards(columns, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'results-cards';

    const titleCol = pickTitleCol(columns);
    const dateCol  = pickDateCol(columns);
    const descCol  = pickDescCol(columns);
    const locCol   = pickLocationCol(columns);
    const titleIdx = columns.indexOf(titleCol);
    const dateIdx  = dateCol ? columns.indexOf(dateCol) : -1;
    const descIdx  = descCol ? columns.indexOf(descCol) : -1;
    const locIdx   = locCol  ? columns.indexOf(locCol)  : -1;

    // Indices we've handled specially — used to filter the metadata footer.
    const usedIdx = new Set([titleIdx, dateIdx, descIdx, locIdx].filter((i) => i >= 0));

    rows.forEach((r) => {
      const card = document.createElement('article');
      card.className = 'result-card';
      if (descIdx < 0) card.classList.add('no-desc');

      // ----- header: title + optional date pill -----
      const head = document.createElement('header');
      head.className = 'result-card-head';
      const title = document.createElement('h3');
      title.className = 'result-card-title';
      title.textContent = formatCell(r[titleIdx]);
      title.title = formatCell(r[titleIdx]);
      head.appendChild(title);
      if (dateIdx >= 0 && dateIdx !== titleIdx) {
        const sub = document.createElement('span');
        sub.className = 'result-card-date';
        sub.textContent = formatCell(r[dateIdx]);
        head.appendChild(sub);
      }
      card.appendChild(head);

      // ----- location row (Address / City / etc.) under the header -----
      if (locIdx >= 0 && locIdx !== titleIdx && locIdx !== dateIdx) {
        const loc = document.createElement('div');
        loc.className = 'result-card-location';
        const icon = document.createElement('span');
        icon.className = 'result-card-location-icon';
        icon.textContent = '📍';
        const text = document.createElement('span');
        text.textContent = formatCell(r[locIdx]);
        loc.append(icon, text);
        card.appendChild(loc);
      }

      // ----- big description body -----
      if (descIdx >= 0) {
        const descLabel = document.createElement('div');
        descLabel.className = 'result-card-desc-label';
        descLabel.textContent = descCol;
        const desc = document.createElement('div');
        desc.className = 'result-card-desc';
        const v = r[descIdx];
        if (v === null || v === undefined || v === '') {
          desc.textContent = 'No ' + descCol.toLowerCase() + '.';
          desc.classList.add('null');
        } else {
          desc.textContent = String(v);
          desc.title = String(v);
        }
        card.append(descLabel, desc);
      }

      // ----- footer: remaining metadata as dt/dd pairs -----
      const remaining = columns
        .map((c, i) => ({ c, i }))
        .filter(({ i }) => !usedIdx.has(i));

      if (remaining.length) {
        const body = document.createElement('dl');
        body.className = 'result-card-body';
        remaining.forEach(({ c, i }) => {
          const dt = document.createElement('dt');
          dt.textContent = c;
          const dd = document.createElement('dd');
          const v = r[i];
          if (v === null || v === undefined || v === '') {
            dd.textContent = '—';
            dd.classList.add('null');
          } else {
            dd.textContent = String(v);
            dd.title = String(v);
          }
          body.append(dt, dd);
        });
        card.appendChild(body);
      }

      wrap.appendChild(card);
    });
    return wrap;
  }

  function formatCell(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }

  // ---------- view toggle ----------------------------------------------
  function setViewMode(mode) {
    viewMode = mode;
    viewTableBtn.classList.toggle('active', mode === 'table');
    viewCardsBtn.classList.toggle('active', mode === 'cards');
    viewTableBtn.setAttribute('aria-selected', mode === 'table' ? 'true' : 'false');
    viewCardsBtn.setAttribute('aria-selected', mode === 'cards' ? 'true' : 'false');
    renderResults();
  }
  viewTableBtn.addEventListener('click', () => setViewMode('table'));
  viewCardsBtn.addEventListener('click', () => setViewMode('cards'));

  exportBtn.addEventListener('click', () => {
    if (!lastResult || !lastResult.rows.length) return;
    const rows = sortedRows(lastResult);
    const csv = toCsv(lastResult.columns, rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTable || 'results'}_${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function toCsv(columns, rows) {
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = columns.map(escape).join(',');
    const body = rows.map((r) => r.map(escape).join(',')).join('\n');
    return head + '\n' + body;
  }

  // ---------- toast -----------------------------------------------------
  let toastTimer = null;
  function toast(msg, kind = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- utils -----------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- kick off --------------------------------------------------
  DataDB.init().catch((err) => {
    toast('Failed to initialise SQL engine: ' + err.message, 'error');
  });
})();
