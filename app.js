const _PHASH = (() => {
  const SIZE = 32, DCTSIZE = 8;
  const cos = [];
  for (let u = 0; u < DCTSIZE; u++) {
    cos[u] = new Float32Array(SIZE);
    for (let x = 0; x < SIZE; x++)
      cos[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE));
  }
  return { SIZE, DCTSIZE, cos };
})();

const S = {
  library: new Map(),
  queryFile: null, queryBlob: null, queryHash: null, querySrc: null,
  targetId: '',
  threshold: 70,
  currentMatches: [], selectedMatches: [],
  sessionLog: [],
  folderHandle: null,
  db: null,
  queue: [], queueRunning: false,
  sidebarCollapsed: false,
};

const _RS = { single: 'original', batch: 'original' };

function setResizeMode(mode, el, scope) {
  const optsId = scope === 'batch' ? 'batchResizeOpts' : 'resizeOpts';
  document.getElementById(optsId).querySelectorAll('.resize-opt')
    .forEach(o => o.classList.remove('active'));
  el.classList.add('active');

  const customRowId = scope === 'batch' ? 'batchResizeCustomRow' : 'resizeCustomRow';
  const hintId      = scope === 'batch' ? 'batchResizeHint'      : 'resizeHint';

  document.getElementById(customRowId).classList.toggle('hidden', mode !== 'custom');

  const hintMap = {
    original: 'Images will be saved at their original size and quality.',
    '1mb': 'Images will be compressed to fit within 1 MB each.',
    '2mb': 'Images will be compressed to fit within 2 MB each.',
    '3mb': 'Images will be compressed to fit within 3 MB each.',
    '4mb': 'Images will be compressed to fit within 4 MB each.',
    '5mb': 'Images will be compressed to fit within 5 MB each.',
    custom: 'Enter a max file size in MB — images larger than this will be compressed.',
  };
  const svgInfo = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  document.getElementById(hintId).innerHTML = `${svgInfo} ${hintMap[mode] || ''}`;

  _RS[scope] = mode;
}

async function compressBlobToSize(blob, targetBytes) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    return blob;
  }

  const canvas = document.createElement('canvas');
  canvas.width  = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();

  const tryQ = q => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));

  const floor = await tryQ(0.05);
  if (!floor || floor.size > targetBytes) return floor || blob;

  let lo = 0.05, hi = 0.92, best = floor;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const b = await tryQ(mid);
    if (b && b.size <= targetBytes) { best = b; lo = mid; } else { hi = mid; }
    if (hi - lo < 0.03) break;
  }
  return best;
}

async function getResizedBlob(blob, scope) {
  const mode = _RS[scope] || 'original';
  if (mode === 'original') return blob;

  const mbMap = { '1mb':1, '2mb':2, '3mb':3, '4mb':4, '5mb':5 };
  let targetMB;
  if (mode === 'custom') {
    const inputId = scope === 'batch' ? 'batchResizeCustomVal' : 'resizeCustomVal';
    targetMB = parseFloat(document.getElementById(inputId)?.value) || 2;
  } else {
    targetMB = mbMap[mode] || 2;
  }

  const targetBytes = targetMB * 1024 * 1024;
  if (blob.size <= targetBytes) return blob;
  return compressBlobToSize(blob, targetBytes);
}

function resizeName(name, wasResized) {
  if (!wasResized) return name;
  return name.replace(/\.(png|gif|webp|bmp|avif|tiff)$/i, '.jpg');
}

async function init() {
  await initDB();
  setupTheme();
  setupEvents();
  updateThreshold();
  checkFSAPI();
  await restoreLibraryFromDB();
}

function setupTheme() {
  const saved = localStorage.getItem('is-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('is-theme', t);
  const lbl = document.getElementById('themeLabel');
  if (lbl) lbl.textContent = t === 'dark' ? 'Dark' : 'Light';
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.innerHTML = t === 'dark'
      ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>'
      : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

function toggleSidebar() {
  S.sidebarCollapsed = !S.sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', S.sidebarCollapsed);
}

function checkFSAPI() {
  if (!window.showDirectoryPicker)
    document.getElementById('fsBrowserWarning').classList.remove('hidden');
}

async function initDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('ImageSyncDB_v2', 1);
    req.onerror = () => rej(req.error);
    req.onsuccess = () => { S.db = req.result; res(); };
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('images'))
        db.createObjectStore('images', { keyPath: 'filename' });
    };
  });
}
function dbSave(filename, data) {
  return new Promise((res, rej) => {
    const tx = S.db.transaction(['images'], 'readwrite');
    const rq = tx.objectStore('images').put({ filename, ...data });
    rq.onerror = () => rej(rq.error); rq.onsuccess = () => res();
  });
}
function dbDelete(filename) {
  return new Promise((res, rej) => {
    const tx = S.db.transaction(['images'], 'readwrite');
    const rq = tx.objectStore('images').delete(filename);
    rq.onerror = () => rej(rq.error); rq.onsuccess = () => res();
  });
}
function dbClear() {
  return new Promise((res, rej) => {
    const tx = S.db.transaction(['images'], 'readwrite');
    const rq = tx.objectStore('images').clear();
    rq.onerror = () => rej(rq.error); rq.onsuccess = () => res();
  });
}
function dbGetAll() {
  return new Promise((res, rej) => {
    const tx = S.db.transaction(['images'], 'readonly');
    const rq = tx.objectStore('images').getAll();
    rq.onerror = () => rej(rq.error); rq.onsuccess = () => res(rq.result);
  });
}

async function restoreLibraryFromDB() {
  let records;
  try { records = await dbGetAll(); } catch(e) { return; }
  if (!records.length) return;
  setStatus('loading');
  const fill  = document.getElementById('progressFill');
  const label = document.getElementById('progressLabel');
  const BATCH = 30;
  let added = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    for (const r of records.slice(i, i + BATCH)) {
      if (!r.hash || !r.blob) continue;
      const blob = r.blob instanceof Blob ? r.blob : new Blob([r.blob], { type: r.mimeType || 'image/jpeg' });
      S.library.set(r.filename, { blob, hash: r.hash });
      addThumb(r.filename, blob);
      added++;
    }
    const pct = Math.min(i + BATCH, records.length);
    if (fill)  fill.style.width = ((pct / records.length) * 100) + '%';
    if (label) label.textContent = `Restoring ${pct} / ${records.length}`;
    updateLibBadge();
    await yieldFrame();
  }
  if (fill)  fill.style.width = '0%';
  if (label) label.textContent = '';
  setStatus('idle');
  if (added > 0) toast(`Restored ${added} images from last session`, 'success');
}

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

function setupEvents() {
  const lz = document.getElementById('libDropZone');
  lz.addEventListener('click', () => document.getElementById('libFileInput').click());
  lz.addEventListener('dragover', e => { e.preventDefault(); lz.classList.add('dragover'); });
  lz.addEventListener('dragleave', () => lz.classList.remove('dragover'));
  lz.addEventListener('drop', e => { e.preventDefault(); lz.classList.remove('dragover'); handleLibUpload(e.dataTransfer.files); });
  document.getElementById('libFileInput').addEventListener('change', e => handleLibUpload(e.target.files));
  document.getElementById('libFolderInput').addEventListener('change', e => handleLibUpload(e.target.files));

  const qz = document.getElementById('queryDropZone');
  qz.addEventListener('click', () => document.getElementById('queryFileInput').click());
  qz.addEventListener('dragover', e => { e.preventDefault(); qz.classList.add('dragover'); });
  qz.addEventListener('dragleave', () => qz.classList.remove('dragover'));
  qz.addEventListener('drop', e => { e.preventDefault(); qz.classList.remove('dragover'); handleQueryAdd(e.dataTransfer.files); });
  document.getElementById('queryFileInput').addEventListener('change', e => handleQueryAdd(e.target.files));

  document.getElementById('threshSlider').addEventListener('input', e => {
    S.threshold = +e.target.value; updateThreshold();
  });
  document.getElementById('targetId').addEventListener('input', e => { S.targetId = e.target.value.trim(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSingle(); closeMulti(); closeFolder(); closeLightbox(); closeLog(); }
    if (e.key === 'Enter') {
      if (document.getElementById('modalSingle').classList.contains('active')) confirmSingle();
      else if (document.getElementById('modalMulti').classList.contains('active')) confirmMulti();
    }
  });
  document.getElementById('lightbox').addEventListener('click', closeLightbox);
}

function updateThreshold() {
  document.getElementById('threshVal').textContent = S.threshold + '%';
  const sl = document.getElementById('threshSlider');
  sl.style.setProperty('--pct', sl.value + '%');
}

async function handleLibUpload(files) {
  const valid = Array.from(files).filter(isImage);
  if (!valid.length) { toast('No valid image files.', 'error'); return; }
  const maxAdd = 1000 - S.library.size;
  if (maxAdd <= 0) { toast('Library is full (1000 images max)', 'warn'); return; }
  const toAdd = valid.slice(0, maxAdd);
  if (valid.length > maxAdd) toast(`Only adding ${maxAdd} of ${valid.length} images`, 'warn');
  setStatus('loading');
  document.getElementById('findBtn').disabled = true;
  const fill  = document.getElementById('progressFill');
  const label = document.getElementById('progressLabel');
  for (let i = 0; i < toAdd.length; i++) {
    const f = toAdd[i];
    const hash = await computeHash(f);
    let name = f.name, c = 1;
    while (S.library.has(name)) {
      const ext = f.name.split('.').pop();
      const base = f.name.substring(0, f.name.lastIndexOf('.'));
      name = `${base}_dup${c++}.${ext}`;
    }
    S.library.set(name, { blob: f, hash });
    await dbSave(name, { blob: f, hash, mimeType: f.type });
    fill.style.width  = (((i + 1) / toAdd.length) * 100) + '%';
    label.textContent = `Loading ${i + 1} / ${toAdd.length}`;
    addThumb(name, f);
    updateLibBadge();
    if (i % 10 === 9) await yieldFrame();
  }
  fill.style.width  = '0%';
  label.textContent = '';
  document.getElementById('findBtn').disabled = false;
  setStatus('idle');
  updateBatchBtn();
  toast(`Added ${toAdd.length} image${toAdd.length !== 1 ? 's' : ''} to library`, 'success');
}

function updateLibBadge() {
  document.getElementById('libraryBadge').textContent = S.library.size + ' / 1000';
}

async function clearLibrary() {
  confirmDialog('Clear all library images? This cannot be undone.', async () => {
    for (const [, entry] of S.library) {
      if (entry.src) URL.revokeObjectURL(entry.src);
    }
    await dbClear();
    S.library.clear();
    document.getElementById('thumbGrid').innerHTML = '';
    updateLibBadge();
    toast('Library cleared', 'info');
  });
}

function addThumb(name, blob) {
  const src = getSrc({ blob });
  const entry = S.library.get(name);
  if (entry) entry.src = src;
  const d = document.createElement('div');
  d.className = 'thumb'; d.dataset.name = name;
  d.innerHTML = `<img src="${src}" loading="lazy" alt="${name}" title="${name}">
    <div class="thumb-del" title="Remove" onclick="removeThumb(event,'${CSS.escape(name)}')">✕</div>`;
  d.querySelector('img').addEventListener('click', () => openLightboxFor(name, src));
  document.getElementById('thumbGrid').appendChild(d);
}

async function removeThumb(e, name) {
  e.stopPropagation();
  const entry = S.library.get(name);
  if (entry?.src) URL.revokeObjectURL(entry.src);
  S.library.delete(name);
  await dbDelete(name);
  const el = document.querySelector(`.thumb[data-name="${CSS.escape(name)}"]`);
  if (el) el.remove();
  updateLibBadge();
  toast(`Removed "${name}"`, 'info');
}

function getSrc(entryOrBlob) {
  if (entryOrBlob instanceof Blob) return URL.createObjectURL(entryOrBlob);
  if (!entryOrBlob.src) entryOrBlob.src = URL.createObjectURL(entryOrBlob.blob);
  return entryOrBlob.src;
}

async function handleQueryAdd(files) {
  const valid = Array.from(files).filter(isImage);
  if (!valid.length) { toast('Invalid image file.', 'error'); return; }
  for (const f of valid) {
    const hash = await computeHash(f);
    S.queue.push({ file: f, blob: f, hash });
  }
  renderQueue();
  if (S.queue.length >= 1 && !S.queueRunning) {
    const q = S.queue[0];
    S.queryFile = q.file; S.queryBlob = q.blob; S.queryHash = q.hash;
    showQueryPreview(q);
  }
}

function showQueryPreview(q) {
  if (S.querySrc) URL.revokeObjectURL(S.querySrc);
  S.querySrc = URL.createObjectURL(q.blob);
  document.getElementById('queryPreviewImg').src = S.querySrc;
  document.getElementById('queryDropWrap').classList.add('hidden');
  document.getElementById('queryImgWrap').classList.remove('hidden');
  document.getElementById('queryMeta').style.display = '';
  document.getElementById('queryFilenameDisplay').textContent = q.file.name;
  document.getElementById('querySizeDisplay').textContent = fmtSize(q.file.size);
  document.getElementById('queryHashDisplay').textContent = q.hash ? q.hash.substring(0, 32) + '…' : '—';
}

function renderQueue() {
  const wrap = document.getElementById('queueSection');
  const list = document.getElementById('queueList');
  const cnt  = document.getElementById('queueCount');
  if (S.queue.length === 0) { wrap.classList.add('hidden'); updateBatchBtn(); return; }
  wrap.classList.remove('hidden');
  cnt.textContent = S.queue.length;
  list.innerHTML  = '';
  S.queue.forEach((q, i) => {
    const li  = document.createElement('div');
    li.className = 'queue-item';
    const src = URL.createObjectURL(q.blob);
    li.innerHTML = `<img class="queue-item-img" src="${src}" loading="lazy">
      <span class="queue-item-name">${q.file.name}</span>
      <span id="qs-${i}"><span class="badge badge-medium" style="font-size:9px">Pending</span></span>
      <button class="btn-icon" style="padding:3px" onclick="removeFromQueue(${i})" title="Remove">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;
    list.appendChild(li);
  });
  updateBatchBtn();
}

function removeFromQueue(i) {
  S.queue.splice(i, 1);
  if (S.queue.length === 0) {
    document.getElementById('queryDropWrap').classList.remove('hidden');
    document.getElementById('queryImgWrap').classList.add('hidden');
    document.getElementById('queryMeta').style.display = 'none';
    if (S.querySrc) { URL.revokeObjectURL(S.querySrc); S.querySrc = null; }
    S.queryFile = null; S.queryBlob = null; S.queryHash = null;
  } else {
    const q = S.queue[0];
    S.queryFile = q.file; S.queryBlob = q.blob; S.queryHash = q.hash;
    showQueryPreview(q);
  }
  renderQueue();
}

function clearQueue() {
  S.queue = [];
  document.getElementById('queryDropWrap').classList.remove('hidden');
  document.getElementById('queryImgWrap').classList.add('hidden');
  document.getElementById('queryMeta').style.display = 'none';
  if (S.querySrc) { URL.revokeObjectURL(S.querySrc); S.querySrc = null; }
  S.queryFile = null; S.queryBlob = null; S.queryHash = null;
  renderQueue();
}

function computeHash(blob) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); res(pHashDCT(img)); };
    img.onerror = () => { URL.revokeObjectURL(url); res(''); };
    img.src = url;
  });
}

function pHashDCT(img) {
  const { SIZE, DCTSIZE, cos } = _PHASH;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx  = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < data.length; i += 4, j++)
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const dct = new Float32Array(DCTSIZE * DCTSIZE);
  for (let u = 0; u < DCTSIZE; u++) {
    const cu = cos[u];
    for (let v = 0; v < DCTSIZE; v++) {
      const cv = cos[v]; let sum = 0;
      for (let x = 0; x < SIZE; x++) {
        const cx = cu[x], rowBase = x * SIZE;
        for (let y = 0; y < SIZE; y++) sum += gray[rowBase + y] * cx * cv[y];
      }
      dct[u * DCTSIZE + v] = sum;
    }
  }
  const vals = dct.subarray(1);
  let avg = 0;
  for (let i = 0; i < vals.length; i++) avg += vals[i];
  avg /= vals.length;
  let hash = '';
  for (let i = 0; i < vals.length; i++) hash += vals[i] > avg ? '1' : '0';
  return hash;
}

function similarity(h1, h2) {
  if (h1.length !== h2.length) {
    const minLen = Math.min(h1.length, h2.length);
    h1 = h1.slice(0, minLen); h2 = h2.slice(0, minLen);
  }
  let dist = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) dist++;
  return Math.round(((h1.length - dist) / h1.length) * 100);
}

async function findSimilarImages() {
  const idEl  = document.getElementById('targetId');
  const idErr = document.getElementById('idError');
  idErr.classList.add('hidden');
  if (!S.queryHash) { idErr.textContent = 'Upload a query image first.'; idErr.classList.remove('hidden'); return; }
  const tid = idEl.value.trim();
  if (!tid) { idErr.textContent = 'Target ID is required.'; idErr.classList.remove('hidden'); return; }
  if (!S.library.size) { toast('Load images into the library first.', 'warn'); return; }
  S.targetId = tid;
  setStatus('busy');
  await yieldFrame();

  const matches = [];
  const entries = [...S.library.entries()];
  const CHUNK   = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    for (let j = i; j < Math.min(i + CHUNK, entries.length); j++) {
      const [fn, data] = entries[j];
      const sim = similarity(S.queryHash, data.hash);
      if (sim >= S.threshold) matches.push({ filename: fn, similarity: sim, data });
    }
    if (i + CHUNK < entries.length) await yieldFrame();
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  S.currentMatches = matches;
  setStatus('idle');
  if (!matches.length) showNoMatch();
  else if (matches.length === 1) showSingleResult(matches[0]);
  else showMultiResult(matches);
}

function showNoMatch() {
  const c = document.getElementById('resultsContainer');
  const qSrc = document.getElementById('queryPreviewImg').src;
  c.innerHTML = `
    <div class="no-match-panel">
      <div style="display:flex;gap:16px;align-items:flex-start">
        <img src="${qSrc}" style="width:80px;height:80px;object-fit:contain;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);flex-shrink:0">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px">No matches found</div>
          <div style="font-size:12.5px;color:var(--text-2);line-height:1.6">
            No library images matched above <strong style="color:var(--accent)">${S.threshold}%</strong> similarity.
          </div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('threshSlider').value=Math.max(0,${S.threshold}-10);S.threshold=Math.max(0,${S.threshold}-10);updateThreshold()">Lower threshold</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('findBtn').click()">Retry search</button>
          </div>
        </div>
      </div>
    </div>`;
  c.classList.remove('hidden');
  document.getElementById('resultsEmpty').classList.add('hidden');
  toast(`No matches above ${S.threshold}%`, 'warn');
}

function showSingleResult(match) {
  document.getElementById('resultsEmpty').classList.add('hidden');
  const ext     = match.filename.split('.').pop();
  const newName = `${S.targetId}.${ext}`;
  const c       = document.getElementById('resultsContainer');
  const qSrc    = document.getElementById('queryPreviewImg').src;
  const mSrc    = getSrc(match.data);

  c.innerHTML = `
    <div class="compare-panel">
      <div class="compare-inner">
        <div class="cmp-img-wrap">
          <div class="cmp-label">Query</div>
          <img src="${qSrc}" class="cmp-img" onclick="openQueryLightbox()" style="cursor:zoom-in">
          <div class="cmp-filename">${S.queryFile ? S.queryFile.name : ''}</div>
          <div class="cmp-size">${S.queryFile ? fmtSize(S.queryFile.size) : ''}</div>
        </div>
        <div class="match-results">
          <div class="match-results-header">
            <span class="match-results-title">Best Match</span>
            ${scoreRing(match.similarity)}
          </div>
          <img src="${mSrc}" class="cmp-img" style="cursor:zoom-in;width:100%;aspect-ratio:auto;max-height:180px"
            onclick="openInlineLightbox('${mSrc}','${match.filename}')">
          <div style="font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--text-2)">${match.filename}</div>
          <div style="font-size:10.5px;color:var(--text-3)">${fmtSize(match.data.blob.size)}</div>
          <div class="rename-preview">
            <span class="rename-from">${match.filename}</span>
            <span class="rename-arrow">→</span>
            <span class="rename-to">${newName}</span>
          </div>
          <button class="btn btn-success w-full" style="margin-top:10px" onclick="openSingleConfirm()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Confirm &amp; Rename
          </button>
        </div>
      </div>
    </div>`;
  c.classList.remove('hidden');

  document.getElementById('cmpQueryImg').src  = qSrc;
  document.getElementById('cmpMatchImg').src  = mSrc;
  document.getElementById('cmpQueryMeta').innerHTML = metaRows([['File', S.queryFile.name], ['Size', fmtSize(S.queryFile.size)]]);
  document.getElementById('cmpMatchMeta').innerHTML = metaRows([['File', match.filename], ['Size', fmtSize(match.data.blob.size)], ['Score', `<span class="badge badge-${simClass(match.similarity)}">${match.similarity}%</span>`]]);
  document.getElementById('singleRenamePreview').innerHTML = `
    <span class="rename-from">${match.filename}</span>
    <span class="rename-arrow">→</span>
    <span class="rename-to">${newName}</span>`;
}

function openSingleConfirm() { document.getElementById('modalSingle').classList.add('active'); }
function closeSingle() { document.getElementById('modalSingle').classList.remove('active'); }
function confirmSingle() {
  const match = S.currentMatches[0];
  const ext   = match.filename.split('.').pop();
  S.selectedMatches = [{ filename: match.filename, newName: `${S.targetId}.${ext}`, data: match.data }];
  closeSingle(); openFolderModal();
}
function metaRows(pairs) {
  return pairs.map(([k, v]) => `<div class="cmp-meta-row"><span>${k}</span><span>${v}</span></div>`).join('');
}

function showMultiResult(matches) {
  document.getElementById('resultsEmpty').classList.add('hidden');
  const c    = document.getElementById('resultsContainer');
  const qSrc = document.getElementById('queryPreviewImg').src;
  const srcs = matches.map(m => getSrc(m.data));

  const cards = srcs.map((src, i) => `
    <div style="display:flex;flex-direction:column;gap:5px">
      <div style="border-radius:var(--r-lg);overflow:hidden;cursor:zoom-in;border:1px solid var(--border)" onclick="openInlineLightbox('${src}','${matches[i].filename}')">
        <img src="${src}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;display:block">
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 1px">
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${matches[i].filename}">${matches[i].filename}</span>
        <span class="badge badge-${simClass(matches[i].similarity)}" style="font-size:9px;flex-shrink:0;margin-left:4px">${matches[i].similarity}%</span>
      </div>
    </div>`).join('');

  c.innerHTML = `
    <div class="compare-panel">
      <div class="compare-inner">
        <div class="cmp-img-wrap">
          <div class="cmp-label">Query</div>
          <img src="${qSrc}" class="cmp-img" onclick="openQueryLightbox()" style="cursor:zoom-in">
          <div class="cmp-filename">${S.queryFile ? S.queryFile.name : ''}</div>
          <div class="cmp-size">${S.queryFile ? fmtSize(S.queryFile.size) : ''}</div>
        </div>
        <div class="match-results">
          <div class="match-results-header">
            <span class="match-results-title">${matches.length} Matches Found</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:7px">${cards}</div>
          <button class="btn btn-success w-full" style="margin-top:12px" onclick="openMultiConfirm()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Select &amp; Rename…
          </button>
        </div>
      </div>
    </div>`;
  c.classList.remove('hidden');

  const grid = document.getElementById('matchGrid');
  grid.innerHTML = '';
  document.getElementById('multiTitle').textContent = `${matches.length} Matches Found`;
  matches.forEach((m, i) => {
    const src  = srcs[i];
    const card = document.createElement('div');
    card.className = 'match-card'; card.dataset.index = i;
    card.innerHTML = `
      <div class="match-card-check" id="chk${i}"></div>
      <img src="${src}" loading="lazy" class="match-card-img" alt="${m.filename}">
      <div class="match-card-body">
        <div class="match-card-name" title="${m.filename}">${m.filename}</div>
        ${scoreRing(m.similarity)}
      </div>`;
    card.addEventListener('click', () => card.classList.toggle('selected'));
    grid.appendChild(card);
  });
}

function openMultiConfirm() { document.getElementById('modalMulti').classList.add('active'); }
function openInlineLightbox(src, name) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxName').textContent = name;
  document.getElementById('lightbox').classList.add('active');
}
function closeMulti() { document.getElementById('modalMulti').classList.remove('active'); }
function confirmMulti() {
  const selected = document.querySelectorAll('.match-card.selected');
  if (!selected.length) { toast('Select at least one match.', 'warn'); return; }
  S.selectedMatches = [];
  let primary = true;
  selected.forEach((card, i) => {
    const idx   = +card.dataset.index;
    const match = S.currentMatches[idx];
    const ext   = match.filename.split('.').pop();
    const newName = primary ? `${S.targetId}.${ext}` : `${S.targetId}_alt${i}.${ext}`;
    primary = false;
    S.selectedMatches.push({ filename: match.filename, newName, data: match.data });
  });
  closeMulti(); openFolderModal();
}

function autoIncrementId() {
  const field = document.getElementById('targetId');
  const val   = field.value.trim();
  if (!val) { toast('Enter a base Target ID first', 'warn'); return; }
  const match = val.match(/^(.*?)(\d+)$/);
  if (match) {
    field.value = match[1] + String(+match[2] + 1).padStart(match[2].length, '0');
  } else { field.value = val + '_001'; }
  S.targetId = field.value;
  toast(`ID set to ${field.value}`, 'info');
}

function openFolderModal() {
  buildSaveStatusList();
  if (!window.showDirectoryPicker)
    document.getElementById('fsBrowserWarning').classList.remove('hidden');
  if (S.folderHandle) setFolderSelected(S.folderHandle.name);
  document.getElementById('saveFolderBtn').disabled = !S.folderHandle && !!window.showDirectoryPicker;
  if (!window.showDirectoryPicker) setFolderSelected('Downloads (fallback)');
  document.getElementById('modalFolder').classList.add('active');
}
function closeFolder() { document.getElementById('modalFolder').classList.remove('active'); }

function buildSaveStatusList() {
  const list = document.getElementById('saveStatusList');
  list.innerHTML = S.selectedMatches.map(m => `
    <div class="save-status-row">
      <span class="save-status-file">${m.newName}</span>
      <span class="save-status-state">
        <svg id="st-${sanitizeId(m.newName)}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-3)">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style="color:var(--text-3);font-size:10px" id="stl-${sanitizeId(m.newName)}">pending</span>
      </span>
    </div>`).join('');
  document.getElementById('saveStatusBox').classList.remove('hidden');
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    S.folderHandle = null; setFolderSelected('Downloads (fallback)'); return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    S.folderHandle = handle; setFolderSelected(handle.name);
  } catch(e) { if (e.name !== 'AbortError') console.error(e); }
}

function setFolderSelected(name) {
  const box  = document.getElementById('folderPickBox');
  const icon = document.getElementById('folderPickIcon');
  box.classList.add('selected');
  icon.classList.add('folder-selected-icon');
  icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
  document.getElementById('folderPickName').textContent = name;
  document.getElementById('folderPickSub').textContent  = 'Folder selected — ready to save';
  document.getElementById('saveFolderBtn').disabled = false;
}

async function saveFilesToFolder() {
  document.getElementById('saveFolderBtn').disabled = true;
  for (const m of S.selectedMatches) {
    const key = sanitizeId(m.newName);
    const ic  = document.getElementById(`st-${key}`);
    const lb  = document.getElementById(`stl-${key}`);
    if (lb) lb.textContent = 'saving…';
    try {
      const outBlob  = await getResizedBlob(m.data.blob, 'single');
      const saveName = resizeName(m.newName, outBlob !== m.data.blob);

      if (S.folderHandle) {
        const fh = await S.folderHandle.getFileHandle(saveName, { create: true });
        const ws = await fh.createWritable();
        await ws.write(outBlob); await ws.close();
      } else {
        const url = URL.createObjectURL(outBlob);
        const a   = document.createElement('a');
        a.href = url; a.download = saveName;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
      }
      if (ic) ic.outerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
      if (lb) { lb.textContent = 'saved'; lb.style.color = 'var(--success)'; }
      S.sessionLog.push({
        time: new Date().toLocaleTimeString(),
        query: S.queryFile ? S.queryFile.name : '—',
        matched: m.filename, saved: saveName,
        folder: S.folderHandle ? S.folderHandle.name : 'Downloads', status: 'success',
      });
    } catch(e) {
      if (ic) ic.outerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      if (lb) { lb.textContent = 'error'; lb.style.color = 'var(--danger)'; }
      S.sessionLog.push({ time: new Date().toLocaleTimeString(), query: S.queryFile ? S.queryFile.name : '—', matched: m.filename, saved: m.newName, folder: '—', status: 'error' });
    }
  }
  updateLog(); updateLogBadge();
  document.getElementById('saveFolderBtn').disabled = false;
  setStatus('ok');
  toast(`Saved ${S.selectedMatches.length} file${S.selectedMatches.length !== 1 ? 's' : ''} successfully`, 'success');
  if (S.queue.length > 0) {
    S.queue.shift(); renderQueue();
    if (S.queue.length > 0) {
      const next = S.queue[0];
      S.queryFile = next.file; S.queryBlob = next.blob; S.queryHash = next.hash;
      showQueryPreview(next);
    } else {
      document.getElementById('queryDropWrap').classList.remove('hidden');
      document.getElementById('queryImgWrap').classList.add('hidden');
      document.getElementById('queryMeta').style.display = 'none';
      if (S.querySrc) { URL.revokeObjectURL(S.querySrc); S.querySrc = null; }
      S.queryFile = null; S.queryBlob = null; S.queryHash = null;
    }
    setTimeout(closeFolder, 700);
  }
}

function openLog() {
  document.getElementById('logDrawer').classList.add('open');
  document.getElementById('logBackdrop').classList.add('active');
}
function closeLog() {
  document.getElementById('logDrawer').classList.remove('open');
  document.getElementById('logBackdrop').classList.remove('active');
}
function updateLog() {
  const body  = document.getElementById('logBody');
  const empty = document.getElementById('logEmpty');
  const table = document.getElementById('logTable');
  if (!S.sessionLog.length) { empty.classList.remove('hidden'); table.classList.add('hidden'); return; }
  empty.classList.add('hidden'); table.classList.remove('hidden');
  body.innerHTML = '';
  S.sessionLog.slice().reverse().forEach(lg => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:var(--text-3);white-space:nowrap;font-size:10px">${lg.time}</td>
      <td class="mono">${truncate(lg.query, 14)}</td>
      <td class="mono">${truncate(lg.matched, 14)}</td>
      <td class="mono">${truncate(lg.saved, 16)}</td>
      <td><span class="badge badge-${lg.status}">${lg.status.toUpperCase()}</span></td>`;
    body.appendChild(tr);
  });
}
function updateLogBadge() {
  const badge = document.getElementById('logCountBadge');
  if (S.sessionLog.length > 0) {
    badge.textContent = S.sessionLog.length;
    badge.classList.remove('hidden');
  } else { badge.classList.add('hidden'); }
}
function exportCSV() {
  if (!S.sessionLog.length) { toast('No log entries yet.', 'warn'); return; }
  let csv = 'Time,Query,Matched,Saved As,Folder,Status\n';
  S.sessionLog.forEach(l => { csv += `"${l.time}","${l.query}","${l.matched}","${l.saved}","${l.folder}","${l.status}"\n`; });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `imagesync_log_${Date.now()}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('CSV exported', 'success');
}
function clearLog() {
  confirmDialog('Clear all session log entries?', () => {
    S.sessionLog = []; updateLog(); updateLogBadge();
    toast('Log cleared', 'info');
  });
}

function setStatus(state) {
  const pill = document.getElementById('statusPill');
  const text = document.getElementById('statusText');
  pill.className = 'status-pill';
  const map = { idle:['idle','Idle'], loading:['busy','Loading…'], busy:['busy','Searching…'], ok:['ok','Saved'] };
  const [cls, lbl] = map[state] || ['idle','Idle'];
  pill.classList.add(cls);
  text.textContent = lbl;
}

function toast(message, type = 'info', duration = 3200) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = {
    success:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warn:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  el.innerHTML = (icons[type] || icons.info) + `<span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 250); }, duration);
}

function confirmDialog(message, onConfirm) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast toast-warn';
  el.style.cssText = 'flex-direction:column;gap:10px;padding-bottom:12px;align-items:flex-start';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;font-weight:600">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
      ${message}
    </div>
    <div style="display:flex;gap:6px;justify-content:flex-end;width:100%">
      <button class="btn btn-ghost btn-xs" id="dlg-no">Cancel</button>
      <button class="btn btn-danger btn-xs" id="dlg-yes">Confirm</button>
    </div>`;
  container.appendChild(el);
  el.querySelector('#dlg-no').addEventListener('click', () => el.remove());
  el.querySelector('#dlg-yes').addEventListener('click', () => { el.remove(); onConfirm(); });
}

function openLightboxFor(name, src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxName').textContent = name;
  document.getElementById('lightbox').classList.add('active');
}
function openQueryLightbox() {
  const img = document.getElementById('queryPreviewImg');
  if (img && img.src) openLightboxFor('Query Image', img.src);
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('active'); }

function scoreRing(score) {
  const r = 15, circ = 2 * Math.PI * r;
  const col    = score >= 90 ? 'var(--success)' : score >= 70 ? 'var(--warn)' : 'var(--danger)';
  const offset = circ * (1 - score / 100);
  return `<div class="score-ring-wrap">
    <svg width="38" height="38" viewBox="0 0 38 38">
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="3"/>
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="${col}" stroke-width="3"
        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
        stroke-linecap="round" transform="rotate(-90 19 19)"
        style="transition:stroke-dashoffset .8s cubic-bezier(.34,1.56,.64,1)"/>
      <text x="19" y="23" text-anchor="middle" fill="${col}" font-size="8" font-weight="700" font-family="JetBrains Mono">${score}%</text>
    </svg>
  </div>`;
}

function isImage(f) {
  return ['image/jpeg','image/png','image/gif','image/webp','image/bmp','image/avif','image/tiff'].includes(f.type);
}
function simClass(s) { return s >= 90 ? 'high' : s >= 70 ? 'medium' : 'low'; }
function fmtSize(b) {
  if (!b) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}
function sanitizeId(str) { return str.replace(/[^a-zA-Z0-9]/g, '_'); }
function truncate(s, n)  { return s.length > n ? s.slice(0, n) + '…' : s; }

const B = {
  results: [],
  folderHandle: null,
  filter: 'all',
};

function updateBatchBtn() {
  const btn   = document.getElementById('batchBtn');
  const badge = document.getElementById('batchCountBadge');
  const hasLib = S.library.size > 0;
  const count  = S.queue.length;
  if (count >= 1 && hasLib) {
    btn.disabled = false;
    btn.classList.add('active');
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    btn.disabled = true;
    btn.classList.remove('active');
    badge.classList.add('hidden');
  }
}

async function runBatchSearch() {
  const tid   = document.getElementById('targetId').value.trim();
  const idErr = document.getElementById('idError');
  idErr.classList.add('hidden');
  if (!tid) { idErr.textContent = 'Target ID is required for batch naming.'; idErr.classList.remove('hidden'); return; }
  if (!S.queue.length) { toast('Add query images to the queue first.', 'warn'); return; }
  if (!S.library.size) { toast('Load images into the library first.', 'warn'); return; }

  S.targetId = tid;
  B.results  = [];
  B.filter   = 'all';

  document.getElementById('batchOverlay').classList.add('active');
  document.getElementById('batchProgressWrap').style.display = '';
  document.getElementById('batchTableBody').innerHTML = '';
  document.getElementById('batchSaveBtn').disabled = true;
  setStatus('busy');

  const fill  = document.getElementById('batchProgressFill');
  const lbl   = document.getElementById('batchProgressLbl');
  const total = S.queue.length;

  function makeId(index) {
    const m = tid.match(/^(.*?)(\d+)$/);
    if (m) {
      const num    = +m[2] + index;
      const padded = String(num).padStart(m[2].length, '0');
      return m[1] + padded;
    }
    return index === 0 ? tid : `${tid}_${String(index + 1).padStart(3, '0')}`;
  }

  const libEntries = [...S.library.entries()];

  for (let i = 0; i < S.queue.length; i++) {
    const qItem = S.queue[i];
    fill.style.width  = ((i / total) * 100) + '%';
    lbl.textContent   = `Processing ${i + 1} / ${total} — ${qItem.file.name}`;

    let bestMatch = null;
    const CHUNK   = 100;
    for (let j = 0; j < libEntries.length; j += CHUNK) {
      for (let k = j; k < Math.min(j + CHUNK, libEntries.length); k++) {
        const [fn, data] = libEntries[k];
        const sim = similarity(qItem.hash, data.hash);
        if (sim >= S.threshold && (!bestMatch || sim > bestMatch.similarity))
          bestMatch = { filename: fn, similarity: sim, data };
      }
      if (j + CHUNK < libEntries.length) await yieldFrame();
    }

    const autoId = makeId(i);
    const ext    = bestMatch ? bestMatch.filename.split('.').pop() : qItem.file.name.split('.').pop();
    B.results.push({
      queryItem: qItem,
      match: bestMatch,
      newName: `${autoId}.${ext}`,
      include: !!bestMatch,
    });

    appendBatchRow(B.results.length - 1);
    updateBatchStats();
    await yieldFrame();
  }

  fill.style.width  = '100%';
  lbl.textContent   = `Done — ${B.results.filter(r => r.match).length} of ${total} matched`;
  setTimeout(() => { document.getElementById('batchProgressWrap').style.display = 'none'; }, 1500);
  setStatus('idle');
  updateBatchStats();
  updateBatchSaveBtn();
}

function appendBatchRow(idx) {
  const r    = B.results[idx];
  const tbody = document.getElementById('batchTableBody');
  const tr   = document.createElement('tr');
  tr.className   = `batch-row${r.match ? '' : ' no-match'}${r.include ? ' selected' : ''}`;
  tr.dataset.idx = idx;

  const qSrc = URL.createObjectURL(r.queryItem.blob);
  const mSrc = r.match ? getSrc(r.match.data) : '';

  tr.innerHTML = `
    <td><input type="checkbox" class="batch-cb" data-idx="${idx}" ${r.include ? 'checked' : ''} ${r.match ? '' : 'disabled'} onchange="onBatchCb(${idx},this.checked)"></td>
    <td>
      <div class="batch-thumb-cell">
        <img class="batch-thumb" src="${qSrc}" onclick="openInlineLightbox('${qSrc}','${r.queryItem.file.name}')">
        <span class="batch-fname" title="${r.queryItem.file.name}">${r.queryItem.file.name}</span>
      </div>
    </td>
    <td><span class="batch-arrow">→</span></td>
    <td>
      ${r.match
        ? `<div class="batch-thumb-cell">
             <img class="batch-thumb" src="${mSrc}" onclick="openInlineLightbox('${mSrc}','${r.match.filename}')">
             <span class="batch-fname" title="${r.match.filename}">${r.match.filename}</span>
           </div>`
        : `<span class="batch-no-match-tag">No match</span>`}
    </td>
    <td>${r.match ? `<span class="badge badge-${simClass(r.match.similarity)}">${r.match.similarity}%</span>` : '—'}</td>
    <td><input type="text" class="batch-id-input" value="${r.newName}" ${r.match ? '' : 'disabled'} onchange="B.results[${idx}].newName=this.value"></td>
    <td><div class="batch-status-icon" id="batchRowStatus-${idx}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-3)">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span style="color:var(--text-3);font-size:10px">pending</span>
    </div></td>`;

  tbody.appendChild(tr);
}

function onBatchCb(idx, checked) {
  B.results[idx].include = checked;
  const tr = document.querySelector(`.batch-row[data-idx="${idx}"]`);
  if (tr) tr.classList.toggle('selected', checked);
  updateBatchStats();
  updateBatchSaveBtn();
}

function toggleBatchSelectAll(checked) {
  B.results.forEach((r, i) => {
    if (!r.match) return;
    r.include = checked;
    const cb = document.querySelector(`.batch-cb[data-idx="${i}"]`);
    if (cb) cb.checked = checked;
    const tr = document.querySelector(`.batch-row[data-idx="${i}"]`);
    if (tr) tr.classList.toggle('selected', checked);
  });
  updateBatchStats();
  updateBatchSaveBtn();
}

function setBatchFilter(mode) {
  B.filter = mode;
  ['bfAll','bfMatched','bfNone'].forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById(mode === 'all' ? 'bfAll' : mode === 'matched' ? 'bfMatched' : 'bfNone').classList.add('active');
  document.querySelectorAll('.batch-row').forEach(tr => {
    const r = B.results[+tr.dataset.idx];
    if (!r) return;
    if (mode === 'matched' && !r.match) tr.style.display = 'none';
    else if (mode === 'none' && r.match) tr.style.display = 'none';
    else tr.style.display = '';
  });
}

function updateBatchStats() {
  const total   = B.results.length;
  const matched = B.results.filter(r => r.match).length;
  const selected = B.results.filter(r => r.include).length;
  document.getElementById('bsTotal').textContent    = total;
  document.getElementById('bsMatched').textContent  = matched;
  document.getElementById('bsNone').textContent     = total - matched;
  document.getElementById('bsSelected').textContent = selected;
}

function updateBatchSaveBtn() {
  const sel = B.results.filter(r => r.include).length;
  const btn = document.getElementById('batchSaveBtn');
  const cnt = document.getElementById('batchSaveCount');
  btn.disabled = sel === 0;
  cnt.textContent = sel;
  sel > 0 ? cnt.classList.remove('hidden') : cnt.classList.add('hidden');
  document.getElementById('batchFootNote').textContent =
    sel > 0 ? `${sel} file${sel !== 1 ? 's' : ''} selected for saving` : 'Select rows and pick a folder to save.';
}

function closeBatch() { document.getElementById('batchOverlay').classList.remove('active'); }

function openBatchFolderModal() {
  if (!window.showDirectoryPicker)
    document.getElementById('batchFsWarn').classList.remove('hidden');
  if (B.folderHandle) setBatchFolderSelected(B.folderHandle.name);
  document.getElementById('batchSaveProgress').classList.add('hidden');
  document.getElementById('batchFolderSaveBtn').disabled = !B.folderHandle && !!window.showDirectoryPicker;
  if (!window.showDirectoryPicker) setBatchFolderSelected('Downloads (fallback)');
  document.getElementById('modalBatchFolder').classList.add('active');
}
function closeBatchFolder() { document.getElementById('modalBatchFolder').classList.remove('active'); }

async function pickBatchFolder() {
  if (!window.showDirectoryPicker) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    B.folderHandle = handle;
    setBatchFolderSelected(handle.name);
  } catch(e) { if (e.name !== 'AbortError') console.error(e); }
}

function setBatchFolderSelected(name) {
  const box  = document.getElementById('batchFolderPickBox');
  const icon = document.getElementById('batchFolderPickIcon');
  box.classList.add('selected');
  icon.classList.add('folder-selected-icon');
  icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
  document.getElementById('batchFolderPickName').textContent = name;
  document.getElementById('batchFolderPickSub').textContent  = 'Folder selected — ready to save';
  document.getElementById('batchFolderSaveBtn').disabled = false;
}

async function executeBatchSave() {
  const toSave = B.results.filter(r => r.include && r.match);
  if (!toSave.length) { toast('Nothing selected.', 'warn'); return; }

  document.getElementById('batchFolderSaveBtn').disabled = true;
  const saveProg = document.getElementById('batchSaveProgress');
  const saveFill = document.getElementById('batchSaveFill');
  const saveLbl  = document.getElementById('batchSaveLbl');
  saveProg.classList.remove('hidden');

  let saved = 0, errors = 0;

  for (let i = 0; i < toSave.length; i++) {
    const item       = toSave[i];
    const statusCell = document.getElementById(`batchRowStatus-${B.results.indexOf(item)}`);

    saveFill.style.width = ((i / toSave.length) * 100) + '%';
    saveLbl.textContent  = `Saving ${i + 1} / ${toSave.length} — ${item.newName}`;

    try {

      const outBlob  = await getResizedBlob(item.match.data.blob, 'batch');
      const saveName = resizeName(item.newName, outBlob !== item.match.data.blob);

      if (B.folderHandle) {
        const fh = await B.folderHandle.getFileHandle(saveName, { create: true });
        const ws = await fh.createWritable();
        await ws.write(outBlob);
        await ws.close();
      } else {
        const url = URL.createObjectURL(outBlob);
        const a   = document.createElement('a');
        a.href = url; a.download = saveName;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      if (statusCell) statusCell.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span style="color:var(--success);font-size:10px">saved</span>`;

      S.sessionLog.push({
        time: new Date().toLocaleTimeString(),
        query: item.queryItem.file.name,
        matched: item.match.filename,
        saved: saveName,
        folder: B.folderHandle ? B.folderHandle.name : 'Downloads',
        status: 'success',
      });
      saved++;
    } catch(e) {
      console.error('Batch save error:', e);
      if (statusCell) statusCell.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        <span style="color:var(--danger);font-size:10px">error</span>`;
      S.sessionLog.push({
        time: new Date().toLocaleTimeString(),
        query: item.queryItem.file.name,
        matched: item.match.filename,
        saved: item.newName, folder: '—', status: 'error',
      });
      errors++;
    }
    await yieldFrame();
  }

  saveFill.style.width = '100%';
  saveLbl.textContent  = `Done — ${saved} saved${errors ? `, ${errors} errors` : ''}`;
  updateLog(); updateLogBadge();
  setStatus('ok');
  toast(`Batch save complete — ${saved} file${saved !== 1 ? 's' : ''} saved`, 'success');
  document.getElementById('batchFolderSaveBtn').disabled = false;
  setTimeout(closeBatchFolder, 800);
}

function exportBatchCSV() {
  if (!B.results.length) { toast('No batch results yet.', 'warn'); return; }
  let csv = 'Query,Best Match,Similarity,Output Name,Included\n';
  B.results.forEach(r => {
    csv += `"${r.queryItem.file.name}","${r.match ? r.match.filename : '—'}","${r.match ? r.match.similarity + '%' : '—'}","${r.newName}","${r.include ? 'yes' : 'no'}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url; a.download = `batch_${Date.now()}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('Batch CSV exported', 'success');
}

window.addEventListener('DOMContentLoaded', () => {
  init();
  const sl = document.getElementById('threshSlider');
  sl.style.setProperty('--pct', sl.value + '%');
  const lbl = document.getElementById('themeLabel');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (lbl) lbl.textContent = isDark ? 'Dark' : 'Light';
});
