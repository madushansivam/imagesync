/* ════════════════════════════════════════════════════════
   ImageSync — image_matcher.js
   All application logic:
    • IndexedDB persist/restore
    • Improved DCT-based pHash (16×16)
    • Batch query queue
    • Dark mode toggle
    • Toast notification system (replaces alert/confirm)
    • Lightbox for thumbnails
    • Auto-increment Target IDs
    • Library clear + per-thumb removal
    • Folder handle memory (sessionStorage)
   ════════════════════════════════════════════════════════ */

/* ── STATE ─────────────────────────────────────────────────── */
const S = {
    library:        new Map(),   // filename → { blob, hash, src }
    queryFile:      null,
    queryBlob:      null,
    queryHash:      null,
    targetId:       '',
    threshold:      70,
    currentMatches: [],
    selectedMatches:[],
    sessionLog:     [],
    renamedFiles:   new Map(),
    folderHandle:   null,
    db:             null,
    queue:          [],          // pending query items
    queueRunning:   false,
};

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
async function init() {
    await initDB();
    setupTheme();
    setupEvents();
    updateThreshold();
    checkFSAPI();
    await restoreLibraryFromDB();
}

/* ── THEME ─────────────────────────────────────────────────── */
function setupTheme() {
    const saved = localStorage.getItem('imgsync-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('imgsync-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ── FS API CHECK ──────────────────────────────────────────── */
function checkFSAPI() {
    if (!window.showDirectoryPicker) {
        document.getElementById('fsBrowserWarning').classList.remove('hidden');
    }
}

/* ── INDEXEDDB ─────────────────────────────────────────────── */
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
        const st = tx.objectStore('images');
        const rq = st.put({ filename, ...data });
        rq.onerror = () => rej(rq.error);
        rq.onsuccess = () => res();
    });
}

function dbDelete(filename) {
    return new Promise((res, rej) => {
        const tx = S.db.transaction(['images'], 'readwrite');
        const st = tx.objectStore('images');
        const rq = st.delete(filename);
        rq.onerror = () => rej(rq.error);
        rq.onsuccess = () => res();
    });
}

function dbClear() {
    return new Promise((res, rej) => {
        const tx = S.db.transaction(['images'], 'readwrite');
        const st = tx.objectStore('images');
        const rq = st.clear();
        rq.onerror = () => rej(rq.error);
        rq.onsuccess = () => res();
    });
}

function dbGetAll() {
    return new Promise((res, rej) => {
        const tx = S.db.transaction(['images'], 'readonly');
        const st = tx.objectStore('images');
        const rq = st.getAll();
        rq.onerror = () => rej(rq.error);
        rq.onsuccess = () => res(rq.result);
    });
}

/* ── RESTORE LIBRARY FROM DB ───────────────────────────────── */
async function restoreLibraryFromDB() {
    let records;
    try { records = await dbGetAll(); } catch(e) { return; }
    if (!records.length) return;

    setStatus('loading');
    const fill = document.getElementById('progressFill');
    const label = document.getElementById('progressLabel');

    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (!r.hash || !r.blob) continue;
        // Reconstruct blob from stored ArrayBuffer-like data
        const blob = r.blob instanceof Blob ? r.blob : new Blob([r.blob], { type: r.mimeType || 'image/jpeg' });
        S.library.set(r.filename, { blob, hash: r.hash });
        addThumb(r.filename, blob, false); // don't re-save to DB
        fill.style.width = (((i + 1) / records.length) * 100) + '%';
        if (label) label.textContent = `Restoring ${i + 1} / ${records.length}`;
    }

    fill.style.width = '0%';
    if (label) label.textContent = '';
    updateLibBadge();
    setStatus('idle');
    if (records.length > 0) toast(`Restored ${records.length} images from last session`, 'success');
}

/* ── EVENTS ────────────────────────────────────────────────── */
function setupEvents() {
    // Library drop zone
    const lz = document.getElementById('libDropZone');
    lz.addEventListener('click', () => document.getElementById('libFileInput').click());
    lz.addEventListener('dragover', e => { e.preventDefault(); lz.classList.add('dragover'); });
    lz.addEventListener('dragleave', () => lz.classList.remove('dragover'));
    lz.addEventListener('drop', e => { e.preventDefault(); lz.classList.remove('dragover'); handleLibUpload(e.dataTransfer.files); });
    document.getElementById('libFileInput').addEventListener('change', e => handleLibUpload(e.target.files));

    // Folder upload
    document.getElementById('libFolderInput').addEventListener('change', e => handleLibUpload(e.target.files));

    // Query drop zone
    const qz = document.getElementById('queryDropZone');
    qz.addEventListener('click', () => document.getElementById('queryFileInput').click());
    qz.addEventListener('dragover', e => { e.preventDefault(); qz.classList.add('dragover'); });
    qz.addEventListener('dragleave', () => qz.classList.remove('dragover'));
    qz.addEventListener('drop', e => { e.preventDefault(); qz.classList.remove('dragover'); handleQueryDrop(e.dataTransfer.files); });
    document.getElementById('queryFileInput').addEventListener('change', e => handleQueryAdd(e.target.files));

    // Threshold
    document.getElementById('threshSlider').addEventListener('input', e => {
        S.threshold = +e.target.value;
        updateThreshold();
    });

    // Target ID auto-increment hint
    document.getElementById('targetId').addEventListener('input', e => {
        S.targetId = e.target.value.trim();
    });

    // Keyboard
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeSingle(); closeMulti(); closeFolder(); closeLightbox(); }
        if (e.key === 'Enter') {
            if (document.getElementById('modalSingle').classList.contains('active')) confirmSingle();
            else if (document.getElementById('modalMulti').classList.contains('active')) confirmMulti();
        }
    });

    // Lightbox close
    document.getElementById('lightbox').addEventListener('click', closeLightbox);
}

function updateThreshold() {
    document.getElementById('threshVal').textContent = S.threshold + '%';
}

/* ══════════════════════════════════════════════════════════════
   LIBRARY UPLOAD
══════════════════════════════════════════════════════════════ */
async function handleLibUpload(files) {
    const valid = Array.from(files).filter(isImage);
    if (!valid.length) { toast('No valid image files. Supported: JPG, PNG, GIF, WebP, BMP', 'error'); return; }

    const maxAdd = 1000 - S.library.size;
    if (maxAdd <= 0) { toast('Library is full (1000 images max)', 'warn'); return; }
    const toAdd = valid.slice(0, maxAdd);
    if (valid.length > maxAdd) toast(`Library limit: only adding ${maxAdd} of ${valid.length} images`, 'warn');

    setStatus('loading');
    document.getElementById('findBtn').disabled = true;
    const fill  = document.getElementById('progressFill');
    const label = document.getElementById('progressLabel');

    for (let i = 0; i < toAdd.length; i++) {
        const f = toAdd[i];
        const blob = new Blob([await f.arrayBuffer()], { type: f.type });
        const hash = await computeHash(blob);
        let name = f.name, c = 1;
        while (S.library.has(name)) {
            const ext  = f.name.split('.').pop();
            const base = f.name.substring(0, f.name.lastIndexOf('.'));
            name = `${base}_dup${c++}.${ext}`;
        }
        S.library.set(name, { blob, hash });
        await dbSave(name, { blob, hash, mimeType: f.type });
        fill.style.width = (((i + 1) / toAdd.length) * 100) + '%';
        label.textContent = `Loading ${i + 1} / ${toAdd.length}`;
        addThumb(name, blob, false);
        updateLibBadge();
    }

    fill.style.width = '0%';
    label.textContent = '';
    document.getElementById('findBtn').disabled = false;
    setStatus('idle');
    toast(`Added ${toAdd.length} image${toAdd.length !== 1 ? 's' : ''} to library`, 'success');
}

function updateLibBadge() {
    document.getElementById('libraryBadge').textContent = S.library.size + ' / 1000';
}

/* ── CLEAR LIBRARY ─────────────────────────────────────────── */
async function clearLibrary() {
    confirmDialog('Clear all library images? This cannot be undone.', async () => {
        await dbClear();
        S.library.clear();
        document.getElementById('thumbGrid').innerHTML = '';
        updateLibBadge();
        toast('Library cleared', 'info');
    });
}

/* ── ADD THUMBNAIL ─────────────────────────────────────────── */
function addThumb(name, blob, openLightbox = true) {
    const r = new FileReader();
    r.onload = e => {
        const src = e.target.result;
        // store src on library entry for lightbox
        if (S.library.has(name)) S.library.get(name).src = src;

        const d = document.createElement('div');
        d.className = 'thumb';
        d.dataset.name = name;
        d.innerHTML = `
            <img src="${src}" alt="${name}" title="${name}">
            <div class="thumb-del" title="Remove" onclick="removeThumb(event,'${CSS.escape(name)}')">✕</div>`;
        d.querySelector('img').addEventListener('click', () => openLightboxFor(name, src));
        document.getElementById('thumbGrid').appendChild(d);
    };
    r.readAsDataURL(blob);
}

async function removeThumb(e, name) {
    e.stopPropagation();
    S.library.delete(name);
    await dbDelete(name);
    const el = document.querySelector(`.thumb[data-name="${CSS.escape(name)}"]`);
    if (el) el.remove();
    updateLibBadge();
    toast(`Removed "${name}"`, 'info');
}

/* ══════════════════════════════════════════════════════════════
   QUERY — BATCH QUEUE
══════════════════════════════════════════════════════════════ */
async function handleQueryDrop(files) {
    await handleQueryAdd(files);
}

async function handleQueryAdd(files) {
    const valid = Array.from(files).filter(isImage);
    if (!valid.length) { toast('Invalid image file.', 'error'); return; }

    for (const f of valid) {
        const blob = new Blob([await f.arrayBuffer()], { type: f.type });
        const hash = await computeHash(blob);
        S.queue.push({ file: f, blob, hash });
    }
    renderQueue();

    // Show the first one as the single query preview if queue just became 1
    if (S.queue.length >= 1 && !S.queueRunning) {
        const q = S.queue[0];
        S.queryFile = q.file; S.queryBlob = q.blob; S.queryHash = q.hash;
        const reader = new FileReader();
        reader.onload = ev => {
            const prev = document.getElementById('queryPreview');
            prev.src = ev.target.result;
            prev.classList.remove('hidden');
            document.getElementById('queryDropZone').style.display = 'none';
        };
        reader.readAsDataURL(q.blob);
    }
}

function renderQueue() {
    const wrap = document.getElementById('queueWrap');
    const list = document.getElementById('queueList');
    const cnt  = document.getElementById('queueCount');

    if (S.queue.length === 0) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    cnt.textContent = S.queue.length;

    list.innerHTML = '';
    S.queue.forEach((q, i) => {
        const li = document.createElement('div');
        li.className = 'queue-item';
        const src = URL.createObjectURL(q.blob);
        li.innerHTML = `
            <img class="queue-item-img" src="${src}">
            <span class="queue-item-name">${q.file.name}</span>
            <span class="queue-status" id="qs-${i}"><span class="badge badge-medium">Pending</span></span>
            <button class="btn-icon btn-xs" onclick="removeFromQueue(${i})" title="Remove">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>`;
        list.appendChild(li);
    });
}

function removeFromQueue(i) {
    S.queue.splice(i, 1);
    if (S.queue.length === 0) {
        // Reset query preview
        document.getElementById('queryPreview').classList.add('hidden');
        document.getElementById('queryDropZone').style.display = '';
        S.queryFile = null; S.queryBlob = null; S.queryHash = null;
    } else {
        const q = S.queue[0];
        S.queryFile = q.file; S.queryBlob = q.blob; S.queryHash = q.hash;
    }
    renderQueue();
}

function clearQueue() {
    S.queue = [];
    document.getElementById('queryPreview').classList.add('hidden');
    document.getElementById('queryDropZone').style.display = '';
    S.queryFile = null; S.queryBlob = null; S.queryHash = null;
    renderQueue();
}

/* ══════════════════════════════════════════════════════════════
   HASHING — DCT-based pHash (16×16 → 64-bit)
══════════════════════════════════════════════════════════════ */
function computeHash(blob) {
    return new Promise(res => {
        const r = new FileReader();
        r.onload = e => {
            const img = new Image();
            img.onload = () => res(pHashDCT(img));
            img.src = e.target.result;
        };
        r.readAsDataURL(blob);
    });
}

function pHashDCT(img) {
    const SIZE = 32; // render at 32×32, DCT on inner 8×8
    const DCTSIZE = 8;
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

    // Grayscale
    const gray = [];
    for (let i = 0; i < data.length; i += 4)
        gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);

    // 2D DCT (top-left 8×8 low-frequency components)
    const dct = [];
    for (let u = 0; u < DCTSIZE; u++) {
        for (let v = 0; v < DCTSIZE; v++) {
            let sum = 0;
            for (let x = 0; x < SIZE; x++) {
                for (let y = 0; y < SIZE; y++) {
                    sum += gray[x * SIZE + y]
                        * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE))
                        * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * SIZE));
                }
            }
            dct.push(sum);
        }
    }

    // Skip DC component (index 0)
    const vals = dct.slice(1);
    const avg  = vals.reduce((a, b) => a + b, 0) / vals.length;
    return vals.map(v => (v > avg ? 1 : 0)).join('');
}

function similarity(h1, h2) {
    if (h1.length !== h2.length) {
        // Fallback for length mismatch (old vs new hash)
        const minLen = Math.min(h1.length, h2.length);
        h1 = h1.slice(0, minLen); h2 = h2.slice(0, minLen);
    }
    let dist = 0;
    for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) dist++;
    return Math.round(((h1.length - dist) / h1.length) * 100);
}

/* ══════════════════════════════════════════════════════════════
   FIND
══════════════════════════════════════════════════════════════ */
async function findSimilarImages() {
    const idEl  = document.getElementById('targetId');
    const idErr = document.getElementById('idError');
    idErr.classList.add('hidden');

    if (!S.queryHash) {
        idErr.textContent = 'Upload a query image first.';
        idErr.classList.remove('hidden');
        return;
    }
    const tid = idEl.value.trim();
    if (!tid) {
        idErr.textContent = 'Target ID is required.';
        idErr.classList.remove('hidden');
        return;
    }
    if (!S.library.size) { toast('Load images into the library first.', 'warn'); return; }

    S.targetId = tid;
    setStatus('busy');

    await new Promise(r => setTimeout(r, 10)); // yield to let UI update

    const matches = [];
    for (const [fn, data] of S.library.entries()) {
        const sim = similarity(S.queryHash, data.hash);
        if (sim >= S.threshold) matches.push({ filename: fn, similarity: sim, data });
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    S.currentMatches = matches;

    setStatus('idle');

    if (!matches.length) {
        showNoMatch();
    } else if (matches.length === 1) {
        showSingleModal(matches[0]);
    } else {
        showMultiModal(matches);
    }
}

function showNoMatch() {
    const c = document.getElementById('resultsContainer');
    c.innerHTML = `
        <div class="inline-compare">
            <div class="inline-compare-query">
                <div class="inline-compare-label">Your Image</div>
                <img src="${document.getElementById('queryPreview').src}" class="inline-compare-img">
                <div class="inline-compare-filename">${S.queryFile ? S.queryFile.name : ''}</div>
            </div>
            <div class="inline-compare-results">
                <div class="inline-compare-label">Results</div>
                <div class="results-empty" style="height:100px;border:1.5px dashed var(--border);border-radius:12px">
                    <div class="results-empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
                    <p>No matches above ${S.threshold}%. Try lowering the threshold.</p>
                </div>
            </div>
        </div>`;
    c.classList.remove('hidden');
    document.getElementById('resultsEmpty').classList.add('hidden');
    toast(`No matches found above ${S.threshold}%`, 'warn');
}

/* ── AUTO-INCREMENT TARGET ID ──────────────────────────────── */
function autoIncrementId() {
    const field = document.getElementById('targetId');
    const val   = field.value.trim();
    if (!val) { toast('Enter a base Target ID first', 'warn'); return; }

    // Match trailing number e.g. PRODUCT_001 → PRODUCT_002
    const match = val.match(/^(.*?)(\d+)$/);
    if (match) {
        const base   = match[1];
        const num    = match[2];
        const next   = String(+num + 1).padStart(num.length, '0');
        field.value  = base + next;
        S.targetId   = field.value;
        toast(`ID incremented to ${field.value}`, 'info');
    } else {
        field.value = val + '_001';
        S.targetId  = field.value;
        toast(`ID set to ${field.value}`, 'info');
    }
}

/* ══════════════════════════════════════════════════════════════
   MODALS — SINGLE MATCH
══════════════════════════════════════════════════════════════ */
function showSingleModal(match) {
    document.getElementById('resultsEmpty').classList.add('hidden');
    const ext     = match.filename.split('.').pop();
    const newName = `${S.targetId}.${ext}`;
    const c       = document.getElementById('resultsContainer');

    // render inline side-by-side first
    const qSrc = document.getElementById('queryPreview').src;
    blobToSrc(match.data.blob, mSrc => {
        c.innerHTML = `
            <div class="inline-compare">
                <div class="inline-compare-query">
                    <div class="inline-compare-label">Your Image</div>
                    <img src="${qSrc}" class="inline-compare-img" onclick="openQueryLightbox()" style="cursor:zoom-in">
                    <div class="inline-compare-filename">${S.queryFile ? S.queryFile.name : ''}</div>
                    <div class="inline-compare-meta">${S.queryFile ? fmtSize(S.queryFile.size) : ''}</div>
                </div>
                <div class="inline-compare-results">
                    <div class="inline-compare-label">Best Match — <span class="badge badge-${simClass(match.similarity)}">${match.similarity}%</span></div>
                    <img src="${mSrc}" class="inline-compare-img" style="cursor:zoom-in" onclick="openInlineLightbox('${mSrc}','${match.filename}')">
                    <div class="inline-compare-filename">${match.filename}</div>
                    <div class="inline-compare-meta">${fmtSize(match.data.blob.size)}</div>
                    <div class="inline-compare-rename">
                        <span class="rename-preview" style="margin-top:6px">
                            <span class="from">${match.filename}</span>
                            <span class="arrow">→</span>
                            <span class="to">${newName}</span>
                        </span>
                    </div>
                    <button class="btn btn-success" style="margin-top:8px;width:100%" onclick="openSingleConfirm()">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        Confirm &amp; Rename
                    </button>
                </div>
            </div>`;
        c.classList.remove('hidden');
    });

    // also populate the modal (so confirm still works)
    blobToSrc(S.queryBlob,     src => document.getElementById('cmpQueryImg').src = src);
    blobToSrc(match.data.blob, src => document.getElementById('cmpMatchImg').src = src);
    document.getElementById('cmpQueryMeta').innerHTML = metaRows([
        ['File', S.queryFile.name],
        ['Size', fmtSize(S.queryFile.size)],
    ]);
    document.getElementById('cmpMatchMeta').innerHTML = metaRows([
        ['File', match.filename],
        ['Size', fmtSize(match.data.blob.size)],
        ['Score', `<span class="badge badge-${simClass(match.similarity)}">${match.similarity}%</span>`],
    ]);
    document.getElementById('singleRenamePreview').innerHTML = `
        <span class="from">${match.filename}</span>
        <span class="arrow">→</span>
        <span class="to">${newName}</span>`;
}

function openSingleConfirm() {
    document.getElementById('modalSingle').classList.add('active');
}

function metaRows(pairs) {
    return pairs.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}
function closeSingle() { document.getElementById('modalSingle').classList.remove('active'); }
function confirmSingle() {
    const match = S.currentMatches[0];
    const ext   = match.filename.split('.').pop();
    S.selectedMatches = [{ filename: match.filename, newName: `${S.targetId}.${ext}`, data: match.data }];
    closeSingle();
    openFolderModal();
}

/* ── MULTI MATCH MODAL ─────────────────────────────────────── */
function showMultiModal(matches) {
    document.getElementById('resultsEmpty').classList.add('hidden');
    const c    = document.getElementById('resultsContainer');
    const qSrc = document.getElementById('queryPreview').src;

    // Build inline side-by-side panel
    let cardsHtml = '';
    const pendingSrcs = [];
    matches.forEach((m, i) => pendingSrcs.push({ m, i, src: null }));

    let loaded = 0;
    matches.forEach((m, i) => {
        blobToSrc(m.data.blob, src => {
            pendingSrcs[i].src = src;
            loaded++;
            if (loaded === matches.length) {
                // all images loaded — render panel
                let cards = pendingSrcs.map(({ m, src }) => `
                    <div class="inline-result-card" onclick="openInlineLightbox('${src}','${m.filename}')">
                        <img src="${src}" class="inline-result-img">
                        <div class="inline-result-info">
                            <span class="inline-result-name" title="${m.filename}">${m.filename}</span>
                            <span class="badge badge-${simClass(m.similarity)}">${m.similarity}%</span>
                        </div>
                    </div>`).join('');

                c.innerHTML = `
                    <div class="inline-compare">
                        <div class="inline-compare-query">
                            <div class="inline-compare-label">Your Image</div>
                            <img src="${qSrc}" class="inline-compare-img" onclick="openQueryLightbox()" style="cursor:zoom-in">
                            <div class="inline-compare-filename">${S.queryFile ? S.queryFile.name : ''}</div>
                            <div class="inline-compare-meta">${S.queryFile ? fmtSize(S.queryFile.size) : ''}</div>
                        </div>
                        <div class="inline-compare-results">
                            <div class="inline-compare-label" style="margin-bottom:8px">${matches.length} Matches — click a card to zoom, then select &amp; confirm below</div>
                            <div class="inline-results-grid">${cards}</div>
                            <button class="btn btn-success" style="margin-top:10px;width:100%" onclick="openMultiConfirm()">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                                Select &amp; Rename…
                            </button>
                        </div>
                    </div>`;
                c.classList.remove('hidden');
            }
        });
    });

    // also keep the modal populated for when they click Select & Rename
    const grid = document.getElementById('matchGrid');
    grid.innerHTML = '';
    if (document.getElementById('multiTitle'))
        document.getElementById('multiTitle').textContent = `${matches.length} Matches Found`;
    matches.forEach((m, i) => {
        blobToSrc(m.data.blob, src => {
            const card = document.createElement('div');
            card.className = 'match-card';
            card.dataset.index = i;
            card.innerHTML = `
                <div class="match-card-check" id="chk${i}"></div>
                <img src="${src}" class="match-card-img" alt="${m.filename}">
                <div class="match-card-body">
                    <div class="match-card-name" title="${m.filename}">${m.filename}</div>
                    <span class="badge badge-${simClass(m.similarity)}">${m.similarity}%</span>
                </div>`;
            card.addEventListener('click', () => card.classList.toggle('selected'));
            grid.appendChild(card);
        });
    });
}

function openMultiConfirm() {
    document.getElementById('modalMulti').classList.add('active');
}

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
        const idx     = +card.dataset.index;
        const match   = S.currentMatches[idx];
        const ext     = match.filename.split('.').pop();
        const newName = primary ? `${S.targetId}.${ext}` : `${S.targetId}_alt${i}.${ext}`;
        primary = false;
        S.selectedMatches.push({ filename: match.filename, newName, data: match.data });
    });
    closeMulti();
    openFolderModal();
}

/* ── FOLDER MODAL ──────────────────────────────────────────── */
function openFolderModal() {
    buildSaveStatusList();
    // Restore previous folder handle display if we have one
    if (S.folderHandle) setFolderSelected(S.folderHandle.name);
    document.getElementById('modalFolder').classList.add('active');
}
function closeFolder() { document.getElementById('modalFolder').classList.remove('active'); }

function buildSaveStatusList() {
    const box  = document.getElementById('saveStatusBox');
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
    box.classList.remove('hidden');
}

async function pickFolder() {
    if (!window.showDirectoryPicker) {
        S.folderHandle = null;
        setFolderSelected('Downloads (fallback)');
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        S.folderHandle = handle;
        setFolderSelected(handle.name);
    } catch (e) {
        if (e.name !== 'AbortError') console.error(e);
    }
}

function setFolderSelected(name) {
    const box  = document.getElementById('folderPickBox');
    const icon = document.getElementById('folderPickIcon');
    const nm   = document.getElementById('folderPickName');
    const sub  = document.getElementById('folderPickSub');
    box.classList.add('selected');
    icon.classList.add('folder-selected-icon');
    icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
    nm.textContent  = name;
    sub.textContent = 'Folder selected — ready to save';
    document.getElementById('saveFolderBtn').disabled = false;
}

/* ── SAVE FILES ────────────────────────────────────────────── */
async function saveFilesToFolder() {
    document.getElementById('saveFolderBtn').disabled = true;

    for (const m of S.selectedMatches) {
        const key = sanitizeId(m.newName);
        const ic  = document.getElementById(`st-${key}`);
        const lb  = document.getElementById(`stl-${key}`);
        if (lb) lb.textContent = 'saving…';

        try {
            if (S.folderHandle) {
                const fh = await S.folderHandle.getFileHandle(m.newName, { create: true });
                const ws = await fh.createWritable();
                await ws.write(m.data.blob);
                await ws.close();
            } else {
                const url = URL.createObjectURL(m.data.blob);
                const a   = document.createElement('a');
                a.href = url; a.download = m.newName;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            if (ic) ic.outerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
            if (lb) { lb.textContent = 'saved'; lb.style.color = 'var(--success)'; }

            S.sessionLog.push({
                time:    new Date().toLocaleTimeString(),
                query:   S.queryFile ? S.queryFile.name : '—',
                matched: m.filename,
                saved:   m.newName,
                folder:  S.folderHandle ? S.folderHandle.name : 'Downloads',
                status:  'success',
            });
        } catch (e) {
            if (ic) ic.outerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
            if (lb) { lb.textContent = 'error'; lb.style.color = 'var(--danger)'; }
            S.sessionLog.push({
                time: new Date().toLocaleTimeString(), query: S.queryFile ? S.queryFile.name : '—',
                matched: m.filename, saved: m.newName, folder: '—', status: 'error',
            });
        }
    }

    updateLog();
    document.getElementById('saveFolderBtn').disabled = false;
    setStatus('ok');
    toast(`Saved ${S.selectedMatches.length} file${S.selectedMatches.length !== 1 ? 's' : ''} successfully`, 'success');

    // Auto-advance queue: remove the first item and set up the next
    if (S.queue.length > 0) {
        S.queue.shift();
        renderQueue();
        if (S.queue.length > 0) {
            const next = S.queue[0];
            S.queryFile = next.file; S.queryBlob = next.blob; S.queryHash = next.hash;
            blobToSrc(next.blob, src => {
                const prev = document.getElementById('queryPreview');
                prev.src = src; prev.classList.remove('hidden');
                document.getElementById('queryDropZone').style.display = 'none';
            });
        } else {
            document.getElementById('queryPreview').classList.add('hidden');
            document.getElementById('queryDropZone').style.display = '';
            S.queryFile = null; S.queryBlob = null; S.queryHash = null;
        }
        // Auto-close after short delay
        setTimeout(closeFolder, 800);
    }
}

/* ── SESSION LOG ───────────────────────────────────────────── */
function updateLog() {
    const body  = document.getElementById('logBody');
    const empty = document.getElementById('logEmpty');
    body.innerHTML = '';
    if (!S.sessionLog.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    S.sessionLog.slice().reverse().forEach(lg => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="white-space:nowrap;color:var(--text-3)">${lg.time}</td>
            <td class="mono">${truncate(lg.query, 14)}</td>
            <td class="mono">${truncate(lg.matched, 14)}</td>
            <td class="mono">${truncate(lg.saved, 16)}</td>
            <td><span class="badge badge-${lg.status}">${lg.status.toUpperCase()}</span></td>`;
        body.appendChild(tr);
    });
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function exportCSV() {
    if (!S.sessionLog.length) { toast('No log entries yet.', 'warn'); return; }
    let csv = 'Time,Query,Matched,Saved As,Folder,Status\n';
    S.sessionLog.forEach(l => {
        csv += `"${l.time}","${l.query}","${l.matched}","${l.saved}","${l.folder}","${l.status}"\n`;
    });
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
        S.sessionLog = [];
        updateLog();
        toast('Log cleared', 'info');
    });
}

/* ── STATUS CHIP ───────────────────────────────────────────── */
function setStatus(state) {
    const chip = document.getElementById('statusChip');
    const text = document.getElementById('statusText');
    chip.className = 'status-chip';
    const map = {
        idle:      ['chip-idle', 'Idle'],
        loading:   ['chip-busy', 'Loading…'],
        searching: ['chip-busy', 'Searching…'],
        busy:      ['chip-busy', 'Searching…'],
        ok:        ['chip-ok',   'Saved'],
    };
    const [cls, label] = map[state] || ['chip-idle', 'Idle'];
    chip.classList.add(cls);
    text.textContent = label;
}

/* ══════════════════════════════════════════════════════════════
   TOAST SYSTEM
══════════════════════════════════════════════════════════════ */
function toast(message, type = 'info', duration = 3200) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;

    const icons = {
        success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
        error:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        warn:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        info:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    };
    el.innerHTML = (icons[type] || icons.info) + `<span>${message}</span>`;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 250);
    }, duration);
}

/* ── CONFIRM DIALOG (toast-based) ──────────────────────────── */
function confirmDialog(message, onConfirm) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast toast-warn';
    el.style.flexDirection = 'column';
    el.style.gap = '10px';
    el.style.paddingBottom = '12px';
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>${message}</span>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" id="dlg-no">Cancel</button>
            <button class="btn btn-danger  btn-xs" id="dlg-yes">Confirm</button>
        </div>`;
    container.appendChild(el);
    el.querySelector('#dlg-no').addEventListener('click', () => el.remove());
    el.querySelector('#dlg-yes').addEventListener('click', () => { el.remove(); onConfirm(); });
}

/* ══════════════════════════════════════════════════════════════
   LIGHTBOX
══════════════════════════════════════════════════════════════ */
function openLightboxFor(name, src) {
    const lb  = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImg');
    const nm  = document.getElementById('lightboxName');
    img.src  = src;
    nm.textContent = name;
    lb.classList.add('active');
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */
function isImage(f) {
    return ['image/jpeg','image/png','image/gif','image/webp','image/bmp','image/avif','image/tiff'].includes(f.type);
}

function blobToSrc(blob, cb) {
    const r = new FileReader();
    r.onload = e => cb(e.target.result);
    r.readAsDataURL(blob);
}

function simClass(s) { if (s >= 90) return 'high'; if (s >= 70) return 'medium'; return 'low'; }

function fmtSize(b) {
    if (!b) return '0 B';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}

function sanitizeId(str) { return str.replace(/[^a-zA-Z0-9]/g, '_'); }

/* ── BOOT ──────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', init);
