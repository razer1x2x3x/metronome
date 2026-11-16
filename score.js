'use strict';
/* ================= 翻譜 (score reader) =================
   Runs alongside the metronome (index.html): it reads S, playing, events, ctx, audioNow(), setBpm(),
   setMeter(), toggle(), holdButton() from the main script.
   Scores are stored only on this device, in IndexedDB:
     pieces  {id, name, created, opened, pages:[{id, file, n, rot}], steps:null|[{pid, bars}], pageBars:{pid:bars}, tempo, pos:{pi, si}}
     files   {id, pieceId, name, type, kind:'pdf'|'img', count, data:ArrayBuffer}
     thumbs  key "file:n:rot" → {type, data}
*/
(() => {
const PDFJS = 'vendor/pdfjs/';
const ABS = p => new URL(p, location.href).href;

/* ---------- small helpers ---------- */
const h = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const collator = new Intl.Collator('zh-Hant', {numeric:true, sensitivity:'base'});
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImg = f => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(f.name);
const baseName = n => n.replace(/\.[^.]+$/, '');
const local = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
};

/* ---------- IndexedDB ---------- */
const DB = (() => {
  let dbp = null;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('score', 3);
      r.onupgradeneeded = e => {
        const d = r.result;
        if(e.oldVersion < 1){
          d.createObjectStore('pieces', {keyPath:'id'});
          d.createObjectStore('files', {keyPath:'id'});
          d.createObjectStore('thumbs');
        }
        const fs = r.transaction.objectStore('files');
        if(!fs.indexNames.contains('pieceId')) fs.createIndex('pieceId', 'pieceId');
        if(!d.objectStoreNames.contains('ink')) d.createObjectStore('ink');
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); res(d); };
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
  return {
    async get(s, k){ const d = await open(); return req(d.transaction(s).objectStore(s).get(k)); },
    async all(s){ const d = await open(); return req(d.transaction(s).objectStore(s).getAll()); },
    async put(s, v, k){ const d = await open(); const t = d.transaction(s, 'readwrite'); k === undefined ? t.objectStore(s).put(v) : t.objectStore(s).put(v, k); return done(t); },
    async del(s, k){ const d = await open(); const t = d.transaction(s, 'readwrite'); t.objectStore(s).delete(k); return done(t); },
    async delRange(s, lo, hi){ const d = await open(); const t = d.transaction(s, 'readwrite'); t.objectStore(s).delete(IDBKeyRange.bound(lo, hi)); return done(t); },
    async fileIdsOf(pieceId){ const d = await open(); return req(d.transaction('files').objectStore('files').index('pieceId').getAllKeys(pieceId)); },
  };
})();

/* ---------- settings ---------- */
const SET = Object.assign({autoFlip:false, flipAt:'beat', countIn:1, keys:false, mini:true, mode:'browse', strip:true,
                           inkShow:true, fingerInk:false, inkTool:'pen', inkColor:'#d0312d', inkSize:'s'},
                          local.get('score.settings', {}) || {});
const saveSet = () => local.set('score.settings', SET);
const UI = Object.assign({tab:'metro', piece:null}, local.get('score.ui', {}) || {});
const saveUI = () => local.set('score.ui', UI);

/* ---------- PDF.js (loaded on first use) ---------- */
let pdfjsP = null;
function pdfjs(){
  if(!pdfjsP) pdfjsP = import('./' + PDFJS + 'pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = ABS(PDFJS + 'pdf.worker.min.mjs');
    return m;
  }).catch(e => { pdfjsP = null; throw e; });
  return pdfjsP;
}
async function openPdf(buf){
  const lib = await pdfjs();
  return lib.getDocument({
    data: new Uint8Array(buf.slice(0)),          // pdf.js takes ownership of the buffer, so hand it a copy
    isEvalSupported: false,
    cMapUrl: ABS(PDFJS + 'cmaps/'), cMapPacked: true,
    standardFontDataUrl: ABS(PDFJS + 'standard_fonts/'),
  }).promise;
}

/* ---------- file / document caches ---------- */
const fileCache = new Map();    // id → Promise<file record>
const docCache = new Map();     // id → Promise<PDFDocumentProxy>
const urlCache = new Map();     // image file id → object URL
const FILE_MEM = 6;             // file records (with their data) kept in memory; older ones are dropped
function getFile(id){
  let p = fileCache.get(id);
  if(p){ fileCache.delete(id); fileCache.set(id, p); return p; }       // most recently used last
  p = DB.get('files', id); fileCache.set(id, p);
  while(fileCache.size > FILE_MEM){
    const old = fileCache.keys().next().value; fileCache.delete(old);
    const u = urlCache.get(old); if(u){ URL.revokeObjectURL(u); urlCache.delete(old); }
  }
  return p;
}
function getDoc(f){ if(!docCache.has(f.id)) docCache.set(f.id, openPdf(f.data)); return docCache.get(f.id); }
function imgURL(f){ if(!urlCache.has(f.id)) urlCache.set(f.id, URL.createObjectURL(new Blob([f.data], {type:f.type || 'image/jpeg'}))); return urlCache.get(f.id); }
function loadImg(src){
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image')); i.src = src; });
}
function dropDocs(){
  for(const p of docCache.values()) p.then(d => d.destroy()).catch(() => {});
  docCache.clear();
  for(const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
  fileCache.clear();
}

/* draw one page into a new canvas that fits inside maxW × maxH device pixels */
const MAX_PIX = 16e6;          // iOS canvas limit is ~16.7 MP
const cropSig = pg => pg.crop ? `:c${pg.crop.l},${pg.crop.t},${pg.crop.r},${pg.crop.b}` : '';
async function drawPage(pg, maxW, maxH, nocrop){
  const f = await getFile(pg.file);
  if(!f) throw new Error('missing file');
  const c = document.createElement('canvas');
  const cr = !nocrop && pg.crop ? pg.crop : {l:0, t:0, r:0, b:0};
  const fw = Math.max(0.05, 1 - cr.l - cr.r), fh = Math.max(0.05, 1 - cr.t - cr.b);
  if(f.kind === 'pdf'){
    const doc = await getDoc(f);
    const page = await doc.getPage(pg.n);
    const rotation = ((page.rotate || 0) + pg.rot) % 360;
    const v1 = page.getViewport({scale:1, rotation});
    const cw = v1.width * fw, ch = v1.height * fh;
    let s = Math.min(maxW / cw, maxH / ch);
    if(cw * ch * s * s > MAX_PIX) s = Math.sqrt(MAX_PIX / (cw * ch));
    const vp = page.getViewport({scale:s, rotation});
    c.width = Math.max(1, Math.floor(vp.width * fw)); c.height = Math.max(1, Math.floor(vp.height * fh));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    const job = {canvasContext:g, viewport:vp};
    if(cr.l || cr.t) job.transform = [1, 0, 0, 1, -vp.width * cr.l, -vp.height * cr.t];
    await page.render(job).promise;
    page.cleanup();
  }else{
    const img = await loadImg(imgURL(f));
    const iw = img.naturalWidth, ih = img.naturalHeight, side = pg.rot % 180 !== 0;
    const w0 = side ? ih : iw, h0 = side ? iw : ih;
    const cw = w0 * fw, ch = h0 * fh;
    let s = Math.min(maxW / cw, maxH / ch);
    if(cw * ch * s * s > MAX_PIX) s = Math.sqrt(MAX_PIX / (cw * ch));
    c.width = Math.max(1, Math.round(cw * s)); c.height = Math.max(1, Math.round(ch * s));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.translate(-cr.l * w0 * s, -cr.t * h0 * s);
    g.translate(w0 * s / 2, h0 * s / 2); g.rotate(pg.rot * Math.PI / 180);
    g.drawImage(img, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
  }
  return c;
}
const freeCanvas = c => { if(c){ c.width = 0; c.height = 0; } };

/* one render at a time; the page on screen jumps the queue */
const rq = []; let rqBusy = false;
function enqueue(key, fn, urgent){
  return new Promise((res, rej) => { const t = {key, fn, res, rej}; urgent ? rq.unshift(t) : rq.push(t); pump(); });
}
function promote(key){ const i = rq.findIndex(t => t.key === key); if(i > 0) rq.unshift(rq.splice(i, 1)[0]); }
async function pump(){
  if(rqBusy) return; rqBusy = true;
  while(rq.length){ const t = rq.shift(); try{ t.res(await t.fn()); }catch(e){ t.rej(e); } }
  rqBusy = false;
}

/* thumbnails (cached in IndexedDB) */
const thumbMem = new Map();     // key → Promise<url>
const thumbKey = pg => `${pg.file}:${pg.n}:${pg.rot}` + cropSig(pg);
function thumb(pg){
  const k = thumbKey(pg);
  if(!thumbMem.has(k)){
    thumbMem.set(k, (async () => {
      let t = await DB.get('thumbs', k).catch(() => null);
      if(!t){
        const c = await enqueue('t:' + k, () => drawPage(pg, 300, 400));
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
        freeCanvas(c);
        t = {type:'image/jpeg', data:await blob.arrayBuffer()};
        DB.put('thumbs', t, k).catch(() => {});
      }
      return URL.createObjectURL(new Blob([t.data], {type:t.type}));
    })().catch(e => { thumbMem.delete(k); throw e; }));
  }
  return thumbMem.get(k);
}
function setThumb(elm, pg){ thumb(pg).then(u => { elm.style.backgroundImage = `url("${u}")`; }).catch(() => { elm.classList.add('bad'); }); }

/* ---------- pieces ---------- */
let pieces = [];
const saveTimers = new Map();
function savePiece(p, now){
  clearTimeout(saveTimers.get(p.id));
  const go = () => { saveTimers.delete(p.id); return DB.put('pieces', p).catch(e => console.error(e)); };
  if(now) return go();
  saveTimers.set(p.id, setTimeout(go, 300));
}
function steps(p){
  const ids = new Set(p.pages.map(x => x.id));
  if(p.steps) return p.steps.filter(s => ids.has(s.pid));
  return p.pages.map(x => ({pid:x.id, bars:(p.pageBars && p.pageBars[x.id]) || 0}));
}
const pageNo = (p, pid) => p.pages.findIndex(x => x.id === pid) + 1;

function parseOrder(txt, N){
  let t = String(txt).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[－—–~～]/g, '-').replace(/[,，、；;>＞→|]/g, ' ').replace(/\s*-\s*/g, '-').trim();
  if(!t) return {ok:true, list:[]};
  const out = [];
  for(const tok of t.split(/\s+/)){
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if(!m) return {ok:false, err:`看不懂「${tok}」，請用數字和空白，例如 1 2 3 1 2 4`};
    const a = +m[1], b = m[2] ? +m[2] : a;
    for(const v of [a, b]) if(v < 1 || v > N) return {ok:false, err:`沒有第 ${v} 頁（共 ${N} 頁）`};
    const d = a <= b ? 1 : -1;
    for(let i = a; ; i += d){ out.push(i); if(i === b) break; }
    if(out.length > 999) return {ok:false, err:'順序太長了'};
  }
  return {ok:true, list:out};
}

/* ---------- import ---------- */
const fileInput = h('input');
fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = 'application/pdf,.pdf,image/*';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);
let pickTarget = null;
function pickFiles(piece){ pickTarget = piece || null; fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  if(!files.length) return;
  const target = pickTarget;
  const p = await importFiles(files, target);
  if(!p) return;
  if(target){ renderEditor(); }
  else{ await openPiece(p.id); openEditor(); }
});

async function importFiles(list, piece){
  const files = [...list].filter(f => isPdf(f) || isImg(f)).sort((a, b) => collator.compare(a.name, b.name));
  const skipped = [...list].filter(f => !isPdf(f) && !isImg(f)).map(f => f.name);
  if(!files.length){ alert('只能匯入 PDF 或圖片檔。'); return null; }
  const p = piece || {id:uid(), name:baseName(files[0].name), created:Date.now(), opened:Date.now(),
                      pages:[], steps:null, pageBars:{}, tempo:null, pos:{pi:0, si:0}};
  const added = [];
  try{
    for(let i = 0; i < files.length; i++){
      const f = files[i];
      busy(`讀取中… ${i + 1} / ${files.length}`);
      const data = await f.arrayBuffer();
      const rec = {id:uid(), pieceId:p.id, name:f.name, type:f.type, kind:isPdf(f) ? 'pdf' : 'img', count:1, data};
      try{
        if(rec.kind === 'pdf'){
          const doc = await openPdf(data);
          rec.count = doc.numPages; doc.destroy();
        }else{
          const u = URL.createObjectURL(new Blob([data], {type:f.type || 'image/jpeg'}));
          try{ await loadImg(u); } finally { URL.revokeObjectURL(u); }
        }
      }catch(e){ skipped.push(f.name); continue; }
      await DB.put('files', rec);
      for(let n = 1; n <= rec.count; n++) added.push({id:uid(), file:rec.id, name:f.name, n, of:rec.count, rot:0});
    }
  }finally{ busy(null); }
  if(!added.length){ alert('無法讀取這些檔案：\n' + skipped.join('\n')); return null; }
  p.pages.push(...added);
  await savePiece(p, true);
  if(!pieces.includes(p)) pieces.push(p);
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); }catch(e){}
  if(skipped.length) alert('以下檔案無法讀取，已略過：\n' + skipped.join('\n'));
  return p;
}

async function deletePiece(p){
  const files = new Set(p.pages.map(x => x.file));
  for(const id of await DB.fileIdsOf(p.id).catch(() => [])) files.add(id);
  for(const id of files){
    await DB.delRange('thumbs', id + ':', id + ':\uffff').catch(() => {});
    await DB.del('files', id).catch(() => {});
  }
  for(const pg of p.pages) await DB.del('ink', pg.id).catch(() => {});
  await DB.del('pieces', p.id);
  pieces = pieces.filter(x => x !== p);
}

/* ================= DOM ================= */
const root = $('score'), tools = $('scoreTools');
root.innerHTML = `
  <div class="sc-lib" id="scLib"></div>
  <div class="sc-reader" id="scReader" hidden>
    <div class="sc-mini" id="scMini">
      <button class="play" id="scPlay"><span class="ico"></span><span id="scPlayTxt">開始</span></button>
      <button class="step" id="scMinus" aria-label="減速">−</button>
      <div class="bpm"><small id="scUnit">♩=</small><span id="scBpm"></span></div>
      <button class="step" id="scPlus" aria-label="加速">+</button>
      <span class="meter" id="scMeter"></span>
      <div class="sc-mdots" id="scDots"></div>
    </div>
    <div id="scInkSlot"></div>
    <div class="sc-stage" id="scStage">
      <div class="sc-sheet" id="scSheet"></div>
      <div class="sc-msg" id="scMsg"></div>
      <div class="sc-zones" id="scZones"><span class="prev">上一頁</span><span class="next">下一頁</span></div>
      <div class="sc-flash" id="scFlash"></div>
      <div class="sc-pos" id="scPos"></div>
    </div>
    <div class="sc-strip" id="scStrip"></div>
  </div>
  <div class="sc-editor" id="scEditor" hidden></div>
  <div class="sc-pop" id="scPop" hidden></div>
  <div class="sc-busy" id="scBusy" hidden><div id="scBusyTxt"></div></div>`;
const libEl = $('scLib'), readerEl = $('scReader'), stage = $('scStage'), sheet = $('scSheet'), msgEl = $('scMsg'),
      posEl = $('scPos'), stripEl = $('scStrip'), editorEl = $('scEditor'), popEl = $('scPop'), miniEl = $('scMini');

function busy(t){ $('scBusy').hidden = !t; if(t) $('scBusyTxt').textContent = t; }

/* ---------- state ---------- */
let tab = 'metro', cur = null, mode = SET.mode === 'perform' ? 'perform' : 'browse', pi = 0, si = 0;
let editorOpen = false, libEdit = false;

/* ---------- tabs ---------- */
function setTab(t){
  tab = t; UI.tab = t; saveUI();
  document.body.dataset.tab = t;
  for(const b of $('tabSeg').children) b.setAttribute('aria-pressed', String(b.dataset.tab === t));
  if(t === 'metro'){ try{ sizeDots(); }catch(e){} needsDraw = true; closePop(); }
  else if(cur) requestAnimationFrame(() => show());
  wake();
}
$('tabSeg').addEventListener('click', e => { const b = e.target.closest('button'); if(b) setTab(b.dataset.tab); });

/* screen stays on while a score is open on the score page */
window.scoreWantsWake = () => tab === 'score' && !!cur;
function wake(){ if(window.scoreWantsWake()) requestWake(); else if(!playing) releaseWake(); }

/* ---------- header tools ---------- */
function renderTools(){
  tools.innerHTML = '';
  if(editorOpen){ tools.append(gearBtn()); return; }
  if(!cur){
    const org = h('button', 'sc-btn' + (libEdit ? ' primary' : ''), libEdit ? '完成' : '整理');
    org.addEventListener('click', () => { libEdit = !libEdit; renderTools(); renderLib(); });
    const imp = h('button', 'sc-btn primary', '＋ 匯入樂譜'); imp.addEventListener('click', () => pickFiles(null));
    if(pieces.length) tools.append(org);
    if(!libEdit) tools.append(imp);
    tools.append(gearBtn());
    return;
  }
  const back = h('button', 'sc-btn', '‹ 曲庫'); back.addEventListener('click', closePiece);
  const title = h('div', 'sc-title'); title.textContent = cur.name;
  const seg = h('div', 'seg sc-mode');
  for(const [m, l] of [['browse', '看譜'], ['perform', '演奏'], ['note', '筆記']]){
    const b = h('button', null, l); b.dataset.mode = m; b.setAttribute('aria-pressed', String(mode === m));
    b.addEventListener('click', () => setMode(m));
    seg.appendChild(b);
  }
  const mini = h('button', 'sc-btn icon', '♩'); mini.id = 'scMiniBtn';
  mini.setAttribute('aria-label', '顯示／隱藏節拍器'); mini.setAttribute('aria-pressed', String(SET.mini));
  mini.addEventListener('click', () => { SET.mini = !SET.mini; saveSet(); renderTools(); renderReaderChrome(); });
  const edit = h('button', 'sc-btn', '編輯'); edit.addEventListener('click', openEditor);
  tools.append(back, title, seg, mini, edit, gearBtn());
}
function gearBtn(){
  const g = h('button', 'sc-btn icon', '⚙'); g.setAttribute('aria-label', '翻譜設定');
  g.addEventListener('click', e => { e.stopPropagation(); popEl.hidden ? openPop() : closePop(); });
  return g;
}

/* ---------- library ---------- */
async function loadPieces(){ pieces = await DB.all('pieces').catch(() => []); }
const LIB_NOTE = '樂譜只存在這台 iPad 裡，不會上傳到網路。刪除主畫面的 App 或清除 Safari 網站資料時，樂譜和筆記也會一起消失，請定期用「匯出整個曲庫」備份。';
function renderLib(){
  libEl.innerHTML = '';
  if(!pieces.length){
    libEdit = false;
    libEl.innerHTML = `<div class="sc-empty"><p>還沒有樂譜。<br>可以一次選多個 PDF 或圖片（例如手機拍的照片），之後再調整頁面順序。</p></div>`;
    const b = h('button', 'sc-btn primary', '＋ 匯入樂譜'); b.addEventListener('click', () => pickFiles(null));
    const r = h('button', 'sc-btn', '從備份檔還原'); r.addEventListener('click', pickBackup);
    const row = h('div', 'sc-row center'); row.append(b, r);
    libEl.firstChild.appendChild(row);
    libEl.firstChild.appendChild(h('p', 'sc-note', LIB_NOTE));
    return;
  }
  const grid = h('div', 'sc-grid' + (libEdit ? ' editing' : ''));
  for(const p of [...pieces].sort((a, b) => (b.opened || 0) - (a.opened || 0))){
    const b = h('div', 'sc-piece'); b.setAttribute('role', 'button'); b.tabIndex = 0;
    const cover = h('div', 'sc-cover');
    if(p.pages[0]) setThumb(cover, p.pages[0]);
    const name = h('div', 'name'); name.textContent = p.name;
    const meta = h('div', 'meta');
    meta.textContent = `${p.pages.length} 頁` + (p.steps ? ` · 演奏順序 ${steps(p).length} 步` : '') +
                       (p.tempo ? ` · ${p.tempo.bpm} BPM ${p.tempo.meter}` : '');
    b.append(cover, name, meta);
    if(libEdit){
      const acts = h('div', 'sc-piece-acts');
      const rn = h('button', 'sc-btn', '重新命名'), del = h('button', 'sc-btn danger', '刪除');
      rn.addEventListener('click', e => {
        e.stopPropagation();
        const v = prompt('曲名', p.name);
        if(v != null && v.trim()){ p.name = v.trim(); savePiece(p); renderLib(); }
      });
      del.addEventListener('click', async e => {
        e.stopPropagation();
        if(!confirm(`刪除「${p.name}」？\n這首曲子的頁面和筆記都會從這台 iPad 刪除，無法復原。`)) return;
        await deletePiece(p);
        if(!pieces.length) libEdit = false;
        renderTools(); renderLib();
      });
      acts.append(rn, del);
      b.appendChild(acts);
    }else{
      b.addEventListener('click', () => openPiece(p.id));
      b.addEventListener('keydown', e => { if(e.key === 'Enter') openPiece(p.id); });
    }
    grid.appendChild(b);
  }
  libEl.appendChild(grid);
  const bk = h('section', 'card sc-backup');
  bk.innerHTML = '<h2>備份</h2><p class="sc-help">把所有曲子（含頁面、裁切、演奏順序、筆記）存成一個備份檔，放到「檔案」App 或 iCloud 雲碟。換 iPad 或重裝 App 時，用「從備份檔還原」匯入回來。</p>';
  const row = h('div', 'sc-row');
  const ex = h('button', 'sc-btn', '匯出整個曲庫'); ex.addEventListener('click', () => exportBackup([...pieces], '樂譜備份'));
  const im = h('button', 'sc-btn', '從備份檔還原'); im.addEventListener('click', pickBackup);
  row.append(ex, im); bk.appendChild(row);
  libEl.appendChild(bk);
  libEl.appendChild(h('p', 'sc-note', LIB_NOTE));
  showUsage();
}
function showUsage(){
  if(!(navigator.storage && navigator.storage.estimate)) return;
  navigator.storage.estimate().then(e => {
    if(!e || !e.usage) return;
    const mb = e.usage / 1048576;
    const t = mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.max(1, Math.round(mb)) + ' MB';
    const el = h('p', 'sc-note sc-usage'); el.textContent = `目前使用空間：約 ${t}（${pieces.length} 首）`;
    libEl.querySelectorAll('.sc-usage').forEach(x => x.remove());
    libEl.appendChild(el);
  }).catch(() => {});
}

/* ---------- open / close ---------- */
async function openPiece(id){
  const p = pieces.find(x => x.id === id);
  if(!p) return;
  if(cur && cur !== p) closePiece(true);
  libEdit = false;
  cur = p; UI.piece = id; saveUI();
  p.opened = Date.now(); savePiece(p);
  const st = steps(p);
  pi = Math.min(Math.max(0, (p.pos && p.pos.pi) || 0), Math.max(0, p.pages.length - 1));
  si = Math.min(Math.max(0, (p.pos && p.pos.si) || 0), Math.max(0, st.length - 1));
  if(p.tempo) applyTempo(p.tempo);
  libEl.hidden = true; readerEl.hidden = false;
  resetZoom();
  renderTools(); renderReaderChrome(); renderStrip();
  wake();
  requestAnimationFrame(() => show());
}
function closePiece(keepView){
  if(!cur) return;
  savePiece(cur, true);
  clearPages(); dropDocs(); dropInk();
  cur = null; UI.piece = null; saveUI();
  if(keepView === true) return;
  closeEditor(true);
  readerEl.hidden = true; libEl.hidden = false;
  renderTools(); renderLib(); wake();
}
function applyTempo(t){
  if(METERS[t.meter]) setMeter(t.meter, t.accents);
  if(SUBS.some(s => s.n === t.subdiv)){ S.subdiv = t.subdiv; renderSub(); }
  setBpm(t.bpm);
}

/* ---------- reader chrome ---------- */
function renderReaderChrome(){
  miniEl.hidden = !SET.mini;
  stripEl.hidden = !(mode !== 'perform' && SET.strip && cur && cur.pages.length > 1);
  renderInkBar();
  readerEl.classList.toggle('strip', !stripEl.hidden);
  stage.classList.toggle('perform', mode === 'perform');
}
function setMode(m){
  if(!cur || m === mode) return;
  const st = steps(cur);
  if(m === 'perform'){
    const pid = cur.pages[pi] && cur.pages[pi].id;
    if(!(st[si] && st[si].pid === pid)){ const k = st.findIndex(s => s.pid === pid); si = k >= 0 ? k : 0; }
    resetZoom();
    if(playing) AF.startN = nearestDownbeat();
    const z = $('scZones'); z.classList.add('show'); setTimeout(() => z.classList.remove('show'), 1600);
  }else if(mode === 'perform'){
    const s = st[si]; if(s){ const k = pageNo(cur, s.pid) - 1; if(k >= 0) pi = k; }
  }
  mode = m; SET.mode = m === 'note' ? 'browse' : m; saveSet();
  renderTools(); renderReaderChrome(); renderStrip(); show();
}

/* page currently on screen */
function curPage(){
  if(!cur || !cur.pages.length) return null;
  if(mode === 'perform'){
    const st = steps(cur); if(!st.length) return null;
    si = Math.min(si, st.length - 1);
    return cur.pages.find(x => x.id === st[si].pid) || null;
  }
  pi = Math.min(pi, cur.pages.length - 1);
  return cur.pages[pi];
}
function neighbours(){
  if(!cur) return [];
  if(mode === 'perform'){
    const st = steps(cur), out = [];
    for(const k of [si + 1, si + 2, si - 1]) if(st[k]){ const pg = cur.pages.find(x => x.id === st[k].pid); if(pg) out.push(pg); }
    return out;
  }
  return [pi + 1, pi - 1, pi + 2].map(k => cur.pages[k]).filter(Boolean);
}

/* ---------- page cache & display ---------- */
const pageCache = new Map();   // key → {p:Promise<canvas>, c:canvas|null}
let hires = null, hiresKey = '';
function stageSize(){
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  return {dpr, W:Math.max(1, Math.floor(stage.clientWidth * dpr)), H:Math.max(1, Math.floor(stage.clientHeight * dpr))};
}
const pageKey = (pg, W, H) => `${pg.id}:${pg.file}:${pg.n}:${pg.rot}${cropSig(pg)}:${W}x${H}`;
function getCanvas(pg, urgent){
  const {W, H} = stageSize();
  const k = pageKey(pg, W, H);
  let e = pageCache.get(k);
  if(e){ if(urgent) promote(k); pageCache.delete(k); pageCache.set(k, e); return e; }   // re-insert: most recently used last
  e = {p:null, c:null};
  e.p = enqueue(k, () => drawPage(pg, W, H), urgent).then(c => { e.c = c; return c; });
  e.p.catch(() => pageCache.delete(k));
  pageCache.set(k, e);
  return e;
}
function trimCache(keep){
  while(pageCache.size > 6){
    const k = [...pageCache.keys()].find(x => !keep.has(x));
    if(!k) break;
    const e = pageCache.get(k); pageCache.delete(k);
    if(e.c && e.c.parentNode !== pw) freeCanvas(e.c);
  }
}
function clearPages(){
  for(const e of pageCache.values()) freeCanvas(e.c);
  pageCache.clear(); rq.length = 0;
  freeCanvas(hires); hires = null; hiresKey = '';
  sheet.innerHTML = '';
}
function mount(c, dpr){
  c.style.width = (c.width / dpr) + 'px'; c.style.height = (c.height / dpr) + 'px';
  if(pw.firstChild !== c || pw.childNodes.length !== 2) pw.replaceChildren(c, inkC);
  if(sheet.firstChild !== pw || sheet.childNodes.length !== 1) sheet.replaceChildren(pw);
  drawInk();
}
let showToken = 0;
function show(){
  if(!cur || tab !== 'score') { updatePos(); return; }
  const pg = curPage();
  const tok = ++showToken;
  dropHires();
  updatePos(); markStrip();
  if(!pg){ sheet.innerHTML = ''; msgEl.textContent = cur.pages.length ? '演奏順序是空的，請到「編輯」設定' : '沒有頁面，請按「編輯」加入'; return; }
  msgEl.textContent = '';
  const {dpr, W, H} = stageSize();
  if(stage.clientWidth < 20 || stage.clientHeight < 20) return;
  loadInk(pg.id).then(() => { if(tok === showToken) drawInk(); });
  const e = getCanvas(pg, true);
  if(e.c) mount(e.c, dpr);
  else{
    // placeholder: the thumbnail, if we have it, so a fast flip never shows the old page
    const ph = h('img'); ph.alt = '';
    const {width, height} = {width:stage.clientWidth, height:stage.clientHeight};
    ph.style.width = width + 'px'; ph.style.height = height + 'px'; ph.style.background = 'transparent'; ph.style.boxShadow = 'none';
    sheet.replaceChildren(ph);
    thumb(pg).then(u => { if(tok === showToken && sheet.firstChild === ph) ph.src = u; }).catch(() => {});
    msgEl.textContent = '';
    e.p.then(c => { if(tok === showToken) mount(c, dpr); }).catch(err => {
      console.error(err); if(tok === showToken){ sheet.innerHTML = ''; msgEl.textContent = '這一頁無法顯示'; }
    });
  }
  const keep = new Set([pageKey(pg, W, H)]);
  for(const n of neighbours()){ getCanvas(n, false); keep.add(pageKey(n, W, H)); }
  trimCache(keep);
  savePos();
}
let posTimer = 0;
function savePos(){ if(!cur) return; cur.pos = {pi, si}; clearTimeout(posTimer); posTimer = setTimeout(() => cur && savePiece(cur), 800); }
let resizeTimer = 0;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if(cur && tab === 'score'){ resetZoom(); show(); } }, 120); }).observe(stage);

/* ---------- position pill ---------- */
let posText = '';
function updatePos(){
  if(!cur){ posEl.hidden = true; return; }
  let t = '';
  if(mode === 'perform'){
    const st = steps(cur);
    if(st.length){
      t = `${si + 1} / ${st.length}<span style="opacity:.7"> · 第 ${pageNo(cur, st[si].pid)} 頁</span>`;
      if(AF.info) t += `<span class="bar">${AF.info}</span>`;
    }
  }else if(cur.pages.length){
    t = `第 ${pi + 1} / ${cur.pages.length} 頁`;
  }
  if(endNote) t = endNote;
  posEl.hidden = !t;
  if(t !== posText){ posText = t; posEl.innerHTML = t; }
}
let endNote = '', endTimer = 0;
function note(t){ endNote = t; updatePos(); clearTimeout(endTimer); endTimer = setTimeout(() => { endNote = ''; updatePos(); }, 1200); }
function flash(){ const f = $('scFlash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); }

/* ---------- navigation ---------- */
let lastFlip = 0;
function go(delta, why){
  if(!cur) return false;
  if(mode === 'perform'){
    const st = steps(cur), n = si + delta;
    if(n < 0 || n >= st.length){ note(n < 0 ? '已經是第一頁' : '已經是最後一頁'); return false; }
    si = n;
    if(why !== 'auto' && playing) AF.startN = Math.max(AF.firstN, nearestDownbeat());
  }else{
    const n = pi + delta;
    if(n < 0 || n >= cur.pages.length){ note(n < 0 ? '已經是第一頁' : '已經是最後一頁'); return false; }
    pi = n; resetZoom();
  }
  lastFlip = performance.now();
  if(mode === 'perform') flash();
  show();
  return true;
}
function jumpPage(k){ if(!cur) return; pi = k; resetZoom(); show(); }

/* ---------- strip of thumbnails (看譜 mode) ---------- */
function renderStrip(){
  stripEl.innerHTML = '';
  if(!cur || stripEl.hidden) return;
  cur.pages.forEach((pg, k) => {
    const b = h('button'); b.appendChild(h('span', null, String(k + 1)));
    b.setAttribute('aria-label', `第 ${k + 1} 頁`);
    b.addEventListener('click', () => jumpPage(k));
    setThumb(b, pg);
    stripEl.appendChild(b);
  });
  markStrip();
}
function markStrip(){
  if(stripEl.hidden) return;
  [...stripEl.children].forEach((b, k) => b.classList.toggle('on', k === pi));
  const on = stripEl.children[pi];
  if(on){
    const l = on.offsetLeft - stripEl.clientWidth / 2 + on.offsetWidth / 2;
    stripEl.scrollTo({left:l, behavior:'smooth'});
  }
}

/* ================= 筆記 (handwritten notes) =================
   Strokes are stored per page in IndexedDB ('ink', key = page id), in the page's own coordinates: 0–1 across
   the page as imported, before the user's rotation and crop. So a note stays next to the same notes when the
   page is rotated or cropped later.
   stroke = {t:'pen'|'hl', c:colour, w:width (fraction of the page size), p:[u, v, pressure, u, v, pressure, …]} */
const INK_COLORS = [['#d0312d', '紅'], ['#1f5bd6', '藍'], ['#1b1b1b', '黑']];
const HL_COLOR = '#ffd400';
const INK_W = {s:0.0026, l:0.0055, hl:0.016};
const inkMem = new Map();      // pid → Promise<strokes[]>
const inkArr = new Map();      // pid → strokes[] (loaded)
const inkPending = new Map();  // pid → timer for a save not yet written
function loadInk(pid){
  if(!inkMem.has(pid)) inkMem.set(pid, DB.get('ink', pid).then(r => (r && r.s) || []).catch(() => []).then(a => {
    if(!inkArr.has(pid)) inkArr.set(pid, a);
    return inkArr.get(pid);
  }));
  return inkMem.get(pid);
}
function writeInk(pid){
  const a = inkArr.get(pid) || [];
  return (a.length ? DB.put('ink', {s:a}, pid) : DB.del('ink', pid)).catch(e => console.error(e));
}
function saveInk(pid){
  clearTimeout(inkPending.get(pid));
  inkPending.set(pid, setTimeout(() => { inkPending.delete(pid); writeInk(pid); }, 400));
}
function flushInk(){
  const all = [];
  for(const [pid, t] of inkPending){ clearTimeout(t); all.push(writeInk(pid)); }
  inkPending.clear();
  return Promise.all(all);
}
function dropInk(){ flushInk(); inkMem.clear(); inkArr.clear(); undoS.length = 0; redoS.length = 0; live = null; }

/* page coordinates (u, v) ↔ pixels on a W × H surface showing the page rotated and cropped */
function inkXf(pg, W, H){
  const c = pg.crop || {l:0, t:0, r:0, b:0};
  const fw = Math.max(0.05, 1 - c.l - c.r), fh = Math.max(0.05, 1 - c.t - c.b);
  const FW = W / fw, FH = H / fh, rot = pg.rot || 0;
  return {
    unit:Math.sqrt(FW * FH),
    to(u, v){
      let x = u, y = v;
      if(rot === 90){ x = 1 - v; y = u; } else if(rot === 180){ x = 1 - u; y = 1 - v; } else if(rot === 270){ x = v; y = 1 - u; }
      return [(x - c.l) * FW, (y - c.t) * FH];
    },
    from(px, py){
      const x = px / FW + c.l, y = py / FH + c.t;
      if(rot === 90) return [y, 1 - x];
      if(rot === 180) return [1 - x, 1 - y];
      if(rot === 270) return [1 - y, x];
      return [x, y];
    },
  };
}
const penW = (s, X, p) => s.w * X.unit * (0.35 + 0.9 * p);
function paintStroke(g, s, X){
  const P = s.p, n = P.length / 3; if(!n) return;
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = s.c; g.fillStyle = s.c;
  if(s.t === 'hl'){
    g.save(); g.globalAlpha = 0.35; g.lineWidth = s.w * X.unit;
    g.beginPath();
    let [x, y] = X.to(P[0], P[1]); g.moveTo(x, y);
    if(n === 1) g.lineTo(x + 0.1, y);
    for(let i = 3; i < P.length; i += 3){ [x, y] = X.to(P[i], P[i + 1]); g.lineTo(x, y); }
    g.stroke(); g.restore();
    return;
  }
  if(n === 1){ const [x, y] = X.to(P[0], P[1]); g.beginPath(); g.arc(x, y, penW(s, X, P[2]) / 2, 0, Math.PI * 2); g.fill(); return; }
  let [x0, y0] = X.to(P[0], P[1]), p0 = P[2];
  for(let i = 3; i < P.length; i += 3){
    const [x1, y1] = X.to(P[i], P[i + 1]), p1 = P[i + 2];
    g.lineWidth = penW(s, X, (p0 + p1) / 2);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    x0 = x1; y0 = y1; p0 = p1;
  }
}

/* the page canvas and the ink canvas on top of it share one wrapper, so zooming moves both */
const pw = h('div', 'sc-pw'), inkC = h('canvas', 'ink');
let live = null;               // stroke being drawn / erasing: {pid, id, X, erase, s, removed}
const inkVisible = () => SET.inkShow !== false || mode === 'note';
function drawInk(){
  const pg = curPage(), base = pw.firstChild;
  if(!pg || !base || base === inkC || !pw.isConnected){ return; }
  const cssW = parseFloat(base.style.width) || 0, cssH = parseFloat(base.style.height) || 0;
  if(!cssW || !cssH) return;
  const k = stageSize().dpr * Math.min(3, Math.max(1, Z.s));
  let W = Math.round(cssW * k), H = Math.round(cssH * k);
  if(W * H > MAX_PIX / 2){ const f = Math.sqrt(MAX_PIX / 2 / (W * H)); W = Math.round(W * f); H = Math.round(H * f); }
  if(inkC.width !== W || inkC.height !== H){ inkC.width = W; inkC.height = H; }
  const g = inkC.getContext('2d'); g.clearRect(0, 0, W, H);
  const strokes = inkArr.get(pg.id);
  if(!strokes){ loadInk(pg.id).then(() => { if(curPage() === pg) drawInk(); }); return; }
  if(!inkVisible()) return;
  const X = inkXf(pg, W, H);
  for(const s of strokes) if(s.t === 'hl') paintStroke(g, s, X);
  if(live && live.s && live.s.t === 'hl' && live.pid === pg.id) paintStroke(g, live.s, X);
  for(const s of strokes) if(s.t !== 'hl') paintStroke(g, s, X);
  if(live && live.s && live.s.t !== 'hl' && live.pid === pg.id) paintStroke(g, live.s, X);
}

/* input: Apple Pencil writes; fingers keep turning pages and zooming (unless 手指也能寫字 is on) */
let lastPenAt = 0;
const inkInput = e => mode === 'note' && (e.pointerType === 'pen' || e.pointerType === 'mouse' || (SET.fingerInk && e.pointerType === 'touch'));
const r4 = v => Math.round(v * 1e4) / 1e4;
function surfacePt(e){
  const r = inkC.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * inkC.width, (e.clientY - r.top) / r.height * inkC.height];
}
function inkStart(e){
  const pg = curPage();
  if(!pg || !inkArr.has(pg.id) || !pw.isConnected || !inkC.width) return false;
  const X = inkXf(pg, inkC.width, inkC.height), [fx, fy] = surfacePt(e);
  lastPenAt = performance.now();
  if(SET.inkTool === 'eraser'){
    live = {pid:pg.id, id:e.pointerId, X, erase:true, removed:[]};
    eraseAt(fx, fy);
    return true;
  }
  const hl = SET.inkTool === 'hl', [u, v] = X.from(fx, fy);
  live = {pid:pg.id, id:e.pointerId, X, s:{t:hl ? 'hl' : 'pen', c:hl ? HL_COLOR : SET.inkColor, w:hl ? INK_W.hl : INK_W[SET.inkSize] || INK_W.s, p:[r4(u), r4(v), pressure(e)]}};
  drawInk();
  return true;
}
const pressure = e => e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5;
function inkMove(e){
  if(!live || e.pointerId !== live.id) return;
  lastPenAt = performance.now();
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  if(!evs || !evs.length) evs = [e];
  const g = inkC.getContext('2d');
  for(const ev of evs){
    const [fx, fy] = surfacePt(ev);
    if(live.erase){ eraseAt(fx, fy); continue; }
    const P = live.s.p, [u, v] = live.X.from(fx, fy);
    const lu = P[P.length - 3], lv = P[P.length - 2];
    if(Math.hypot(u - lu, v - lv) < 0.0007) continue;
    P.push(r4(u), r4(v), pressure(ev));
    if(live.s.t === 'pen'){                     // draw just the new piece
      const n = P.length;
      const [x0, y0] = live.X.to(P[n - 6], P[n - 5]), [x1, y1] = live.X.to(P[n - 3], P[n - 2]);
      g.lineCap = 'round'; g.strokeStyle = live.s.c; g.lineWidth = penW(live.s, live.X, (P[n - 4] + P[n - 1]) / 2);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
  }
  if(live.s && live.s.t === 'hl') drawInk();
}
function inkEnd(e){
  if(!live || e.pointerId !== live.id) return;
  const L = live; live = null; lastPenAt = performance.now();
  const arr = inkArr.get(L.pid); if(!arr) return;
  if(L.erase){ if(L.removed.length) pushUndo({pid:L.pid, kind:'del', items:L.removed}); }
  else{ arr.push(L.s); pushUndo({pid:L.pid, kind:'add', s:L.s}); }
  saveInk(L.pid); drawInk();
}
function eraseAt(fx, fy){
  const arr = inkArr.get(live.pid); if(!arr) return;
  const rr = 12 * (inkC.width / (inkC.getBoundingClientRect().width || 1));
  let hit = false;
  for(let i = arr.length - 1; i >= 0; i--){
    const s = arr[i], P = s.p, half = s.w * live.X.unit / 2;
    for(let j = 0; j < P.length; j += 3){
      const [x, y] = live.X.to(P[j], P[j + 1]);
      if(Math.hypot(x - fx, y - fy) < rr + half){
        // remember where it was, in the original order, so 復原 can put it back
        live.removed.push({s, i});
        arr.splice(i, 1); hit = true; break;
      }
    }
  }
  if(hit) drawInk();
}

/* 復原 / 重做 */
const undoS = [], redoS = [];
function pushUndo(op){ undoS.push(op); if(undoS.length > 300) undoS.shift(); redoS.length = 0; renderInkBar(); }
function runOp(op, undo){
  const arr = inkArr.get(op.pid); if(!arr) return;
  if(op.kind === 'add'){
    if(undo){ const k = arr.lastIndexOf(op.s); if(k >= 0) arr.splice(k, 1); } else arr.push(op.s);
  }else if(op.kind === 'del'){
    if(undo){ for(let j = op.items.length - 1; j >= 0; j--){ const it = op.items[j]; arr.splice(Math.min(it.i, arr.length), 0, it.s); } }
    else{ for(const it of op.items){ const k = arr.indexOf(it.s); if(k >= 0) arr.splice(k, 1); } }
  }else if(op.kind === 'clear'){
    if(undo) arr.push(...op.items); else arr.length = 0;
  }
  saveInk(op.pid);
  const k = cur ? cur.pages.findIndex(x => x.id === op.pid) : -1;      // show the page that changed
  if(k >= 0 && mode !== 'perform' && k !== pi){ pi = k; resetZoom(); show(); } else drawInk();
  renderInkBar();
}
function undoInk(){ const op = undoS.pop(); if(op){ redoS.push(op); runOp(op, true); } }
function redoInk(){ const op = redoS.pop(); if(op){ undoS.push(op); runOp(op, false); } }
function clearPageInk(){
  const pg = curPage(), arr = pg && inkArr.get(pg.id);
  if(!arr || !arr.length) return;
  if(!confirm('清除這一頁的所有筆記？（可以按「復原」救回來）')) return;
  pushUndo({pid:pg.id, kind:'clear', items:arr.slice()});
  arr.length = 0; saveInk(pg.id); drawInk();
}

/* toolbar (筆記 mode) */
const inkBar = h('div', 'sc-inkbar'); inkBar.id = 'scInk';
function renderInkBar(){
  if(mode !== 'note'){ inkBar.hidden = true; return; }
  inkBar.hidden = false;
  const t = SET.inkTool;
  inkBar.innerHTML = '';
  const btn = (html, lab, on, fn, cls) => { const b = h('button', 'ib' + (cls ? ' ' + cls : ''), html); b.setAttribute('aria-label', lab); b.setAttribute('aria-pressed', String(!!on)); b.addEventListener('click', fn); inkBar.appendChild(b); return b; };
  for(const [c, n] of INK_COLORS){
    btn(`<span class="sw" style="background:${c}"></span>`, n + '筆', t === 'pen' && SET.inkColor === c, () => { SET.inkTool = 'pen'; SET.inkColor = c; saveSet(); renderInkBar(); }, 'col');
  }
  inkBar.appendChild(h('span', 'sep'));
  btn('<span class="ln s"></span>', '細', SET.inkSize === 's', () => { SET.inkSize = 's'; if(SET.inkTool !== 'pen') SET.inkTool = 'pen'; saveSet(); renderInkBar(); });
  btn('<span class="ln l"></span>', '粗', SET.inkSize === 'l', () => { SET.inkSize = 'l'; if(SET.inkTool !== 'pen') SET.inkTool = 'pen'; saveSet(); renderInkBar(); });
  inkBar.appendChild(h('span', 'sep'));
  btn('螢光筆', '螢光筆', t === 'hl', () => { SET.inkTool = 'hl'; saveSet(); renderInkBar(); }, 'txt');
  btn('橡皮擦', '橡皮擦', t === 'eraser', () => { SET.inkTool = 'eraser'; saveSet(); renderInkBar(); }, 'txt');
  inkBar.appendChild(h('span', 'sep'));
  const u = btn('↶', '復原', false, undoInk); u.disabled = !undoS.length;
  const r = btn('↷', '重做', false, redoInk); r.disabled = !redoS.length;
  inkBar.appendChild(h('span', 'sp'));
  btn('清除這頁', '清除這一頁的筆記', false, clearPageInk, 'txt');
}

/* ---------- touch: tap / swipe / pinch ---------- */
const Z = {s:1, x:0, y:0};
function applyZoom(){ sheet.style.transform = Z.s === 1 ? '' : `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`; }
function resetZoom(){ Z.s = 1; Z.x = 0; Z.y = 0; applyZoom(); dropHires(); }
function clampZoom(){
  const W = stage.clientWidth, H = stage.clientHeight;
  Z.s = Math.min(4, Math.max(1, Z.s));
  if(Z.s < 1.03){ resetZoom(); return; }
  Z.x = Math.min(0, Math.max(W - W * Z.s, Z.x));
  Z.y = Math.min(0, Math.max(H - H * Z.s, Z.y));
  applyZoom();
}
function dropHires(){
  if(!hires) return;
  const c = hires; hires = null; hiresKey = '';
  const pg = curPage();
  if(pg){ const e = getCanvas(pg, true); if(e.c) mount(e.c, stageSize().dpr); }
  freeCanvas(c);
}
let hiresTimer = 0;
function sharpen(){        // after zooming, re-render the page at the zoomed resolution
  clearTimeout(hiresTimer);
  hiresTimer = setTimeout(() => {
    const pg = curPage(); if(!pg || Z.s < 1.2) return;
    const {dpr, W, H} = stageSize(), s = Z.s;
    const k = pageKey(pg, Math.round(W * s), Math.round(H * s));
    if(k === hiresKey) return;
    hiresKey = k;
    enqueue('z:' + k, () => drawPage(pg, W * s, H * s), true).then(c => {
      if(hiresKey !== k || Z.s < 1.2){ freeCanvas(c); return; }
      const base = getCanvas(pg, false).c;
      const bw = base ? base.width / dpr : c.width / dpr / s, bh = base ? base.height / dpr : c.height / dpr / s;
      c.style.width = bw + 'px'; c.style.height = bh + 'px';
      const old = hires; hires = c; pw.replaceChildren(c, inkC); if(sheet.firstChild !== pw) sheet.replaceChildren(pw); if(old) freeCanvas(old);
      drawInk();
    }).catch(() => {});
  }, 250);
}

const ptrs = new Map();
let G = null, lastTap = {t:0, x:0, y:0};
stage.addEventListener('gesturestart', e => e.preventDefault());
stage.addEventListener('pointerdown', e => {
  if(!cur) return;
  if(inkInput(e)){
    if(live) return;
    try{ stage.setPointerCapture(e.pointerId); }catch(err){}
    inkStart(e); e.preventDefault(); return;
  }
  if(mode === 'note' && e.pointerType === 'touch' && (live || performance.now() - lastPenAt < 600)) return;   // palm while writing
  try{ stage.setPointerCapture(e.pointerId); }catch(err){}
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  const r = stage.getBoundingClientRect();
  if(ptrs.size === 1){
    G = {x0:e.clientX, y0:e.clientY, t0:performance.now(), multi:false, zx:Z.x, zy:Z.y, r};
  }else if(ptrs.size === 2 && G){
    G.multi = true;
    if(mode !== 'perform'){
      const [a, b] = [...ptrs.values()];
      G.pinch = {d0:Math.hypot(a.x - b.x, a.y - b.y) || 1, s0:Z.s, x0:Z.x, y0:Z.y,
                 mx:(a.x + b.x) / 2 - r.left, my:(a.y + b.y) / 2 - r.top};
    }
  }
});
stage.addEventListener('pointermove', e => {
  if(live && e.pointerId === live.id){ inkMove(e); return; }
  if(!ptrs.has(e.pointerId) || !G) return;
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(mode === 'perform') return;
  if(G.pinch && ptrs.size >= 2){
    const [a, b] = [...ptrs.values()], P = G.pinch;
    const s = Math.min(5, Math.max(0.8, P.s0 * Math.hypot(a.x - b.x, a.y - b.y) / P.d0));
    const mx = (a.x + b.x) / 2 - G.r.left, my = (a.y + b.y) / 2 - G.r.top;
    const ux = (P.mx - P.x0) / P.s0, uy = (P.my - P.y0) / P.s0;
    Z.s = s; Z.x = mx - s * ux; Z.y = my - s * uy; applyZoom();
  }else if(!G.multi && Z.s > 1){
    Z.x = G.zx + e.clientX - G.x0; Z.y = G.zy + e.clientY - G.y0;
    clampZoom();
  }
});
function endPointer(e){
  if(live && e.pointerId === live.id){ inkEnd(e); return; }
  if(!ptrs.has(e.pointerId)) return;
  const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  if(!G) return;
  if(G.pinch){ if(ptrs.size < 2){ G.pinch = null; clampZoom(); sharpen(); drawInk(); } if(!ptrs.size) G = null; return; }
  if(ptrs.size) return;
  const g = G; G = null;
  if(g.multi || e.type === 'pointercancel') return;
  const dx = p.x - g.x0, dy = p.y - g.y0, dt = performance.now() - g.t0;
  const swipe = Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 900;
  const tapped = Math.abs(dx) < 14 && Math.abs(dy) < 14 && dt < 600;
  if(mode === 'perform'){
    if(performance.now() - lastFlip < 400) return;        // a palm or a double touch must not turn two pages
    if(swipe) go(dx < 0 ? 1 : -1);
    else if(tapped) go(p.x - g.r.left < g.r.width * 0.2 ? -1 : 1);
    return;
  }
  // 看譜 / 筆記
  if(mode === 'note' && lastPenAt > g.t0 - 300) return;          // the pen was used during this touch: it was a palm
  if(Z.s > 1.03){
    if(tapped && dt < 300 && performance.now() - lastTap.t < 320){ resetZoom(); lastTap.t = 0; }
    else if(tapped) lastTap = {t:performance.now(), x:p.x, y:p.y};
    return;
  }
  if(swipe){ go(dx < 0 ? 1 : -1); return; }
  if(tapped){
    const now = performance.now();
    if(now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40){   // double tap: zoom in there
      lastTap.t = 0;
      const mx = p.x - g.r.left, my = p.y - g.r.top, s = 2.2;
      Z.s = s; Z.x = mx - s * mx; Z.y = my - s * my; clampZoom(); sharpen();
      SET.strip = !SET.strip; saveSet();       // undo the strip toggle from the first tap
      renderReaderChrome(); renderStrip();
      return;
    }
    lastTap = {t:now, x:p.x, y:p.y};
    SET.strip = !SET.strip; saveSet();
    renderReaderChrome(); renderStrip();
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

/* ---------- keyboard / pedal ---------- */
window.scoreKey = e => {
  if(!SET.keys || tab !== 'score' || !cur || editorOpen || e.metaKey || e.ctrlKey || e.altKey) return false;
  const k = e.key;
  let d = 0;
  if(k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') d = 1;
  else if(k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') d = -1;
  if(!d) return false;
  e.preventDefault();
  if(!e.repeat) go(d);
  return true;
};

/* ---------- mini metronome ---------- */
$('scPlay').addEventListener('click', toggle);
holdButton($('scMinus'), -1);
holdButton($('scPlus'), +1);
let dotsSig = '', dotEls2 = [];
function renderMini(){
  $('scBpm').textContent = S.bpm;
  $('scUnit').textContent = (METERS[S.meter].unit === 8 ? '♪' : '♩') + '=';
  $('scMeter').textContent = S.meter;
  $('scPlay').classList.toggle('on', playing);
  $('scPlayTxt').textContent = playing ? '停止' : '開始';
  const sig = S.accents.join('');
  if(sig !== dotsSig){
    dotsSig = sig;
    const box = $('scDots'); box.innerHTML = '';
    dotEls2 = S.accents.map(lv => { const d = h('span', 'sc-mdot' + (lv === 3 ? ' a' : lv === 0 ? ' m' : '')); box.appendChild(d); return d; });
  }
}
hooks.bpm.push(renderMini); hooks.transport.push(renderMini); hooks.meter.push(renderMini);
hooks.transport.push(() => { if(!playing) wake(); });

/* ---------- auto page turn, following the metronome ----------
   Beats are counted from the metronome's own schedule (events: {time, beat, n}), so the page turns on the
   beat you hear. startN = beat number where the current step's bar 1 begins. */
const AF = {startN:0, firstN:0, was:false, info:''};
function heard(now){ for(let i = events.length - 1; i >= 0; i--) if(events[i].time <= now) return events[i]; return null; }
function nearestDownbeat(){
  if(!ctx || !events.length) return AF.startN;
  const now = audioNow(), e = heard(now);
  if(!e) return AF.firstN;
  const M = S.accents.length, ph = Math.min(1, Math.max(0, (now - e.time) / e.dur));
  const base = e.n - e.beat;
  return e.beat + ph < M / 2 ? base : base + M;
}
function tickAuto(){
  if(playing && !AF.was){ AF.firstN = AF.startN = SET.countIn * S.accents.length; }
  AF.was = playing;
  let info = '';
  if(SET.autoFlip && cur && mode === 'perform' && playing && ctx && events.length){
    const st = steps(cur), s = st[si], M = S.accents.length, e = heard(audioNow());
    if(e && s){
      if(e.n < AF.firstN) info = `預備 ${Math.ceil((AF.firstN - e.n) / M)}`;
      else if(s.bars > 0) info = `小節 ${Math.min(s.bars, Math.max(0, Math.floor((e.n - AF.startN) / M)) + 1)} / ${s.bars}`;   // turned early: still bar 1
      if(s.bars > 0 && si < st.length - 1){
        const endN = AF.startN + s.bars * M;
        const off = SET.flipAt === 'bar' ? M : SET.flipAt === 'none' ? 0 : 1;
        if(e.n >= endN - off){
          si++; AF.startN = endN; lastFlip = performance.now(); flash(); show();
        }
      }
    }
  }
  if(info !== AF.info){ AF.info = info; updatePos(); }
}

/* per-frame: beat lights on the mini bar, auto turn */
let litDot = -1, lastBeatN = -1;
function frame2(){
  requestAnimationFrame(frame2);
  tickAuto();
  if(!cur || tab !== 'score') return;
  let on = -1, e = null;
  if(playing && ctx && events.length){
    const now = audioNow(); e = heard(now);
    if(e && now - e.time < Math.min(0.18, e.dur * 0.6) && e.level > 0) on = e.beat;
  }
  if(on !== litDot){
    if(dotEls2[litDot]) dotEls2[litDot].classList.remove('on');
    if(dotEls2[on]) dotEls2[on].classList.add('on');
    litDot = on;
    if(!SET.mini){ const b = $('scMiniBtn'); if(b) b.classList.toggle('beat', on >= 0); }
  }
}

/* ---------- settings popover ---------- */
function openPop(){
  popEl.hidden = false;
  popEl.classList.toggle('off', !SET.autoFlip);
  popEl.innerHTML = `
    <h3>翻譜設定</h3>
    <label class="sc-chk"><input type="checkbox" id="spAuto" ${SET.autoFlip ? 'checked' : ''}>跟著節拍器自動翻頁</label>
    <div class="sc-sub" id="spAutoSub">
      <label>翻頁時機
        <select id="spAt">
          <option value="beat">最後一拍</option><option value="bar">提早一小節</option><option value="none">小節結束時</option>
        </select></label>
      <label>預備小節
        <select id="spCount"><option value="0">無</option><option value="1">1 小節</option><option value="2">2 小節</option></select></label>
      <p>只在「演奏」模式、節拍器在跑的時候作用。到「編輯」填每一步的小節數；按節拍器「開始」時，從目前這一頁的第 1 小節算起（先數預備小節）。中途手動翻頁也會重新對齊。</p>
    </div>
    <hr>
    <label class="sc-chk"><input type="checkbox" id="spKeys" ${SET.keys ? 'checked' : ''}>鍵盤／藍牙踏板翻頁</label>
    <p>開啟後在翻譜頁：→ ↓ PageDown 下一頁，← ↑ PageUp 上一頁（這時方向鍵不再調整速度）。空白鍵仍是節拍器開始／停止。</p>
    <hr>
    <label class="sc-chk"><input type="checkbox" id="spInk" ${SET.inkShow !== false ? 'checked' : ''}>看譜、演奏時顯示筆記</label>
    <label class="sc-chk"><input type="checkbox" id="spFinger" ${SET.fingerInk ? 'checked' : ''}>手指也能寫字</label>
    <p>預設只有 Apple Pencil 會寫字，手指在「筆記」模式裡照樣可以滑動翻頁、雙指縮放，手掌碰到螢幕也不會畫出線。</p>`;
  $('spAt').value = SET.flipAt; $('spCount').value = String(SET.countIn);
  $('spAuto').addEventListener('change', e => { SET.autoFlip = e.target.checked; saveSet(); popEl.classList.toggle('off', !SET.autoFlip); if(editorOpen) renderEditor(); });
  $('spAt').addEventListener('change', e => { SET.flipAt = e.target.value; saveSet(); });
  $('spCount').addEventListener('change', e => { SET.countIn = +e.target.value; saveSet(); });
  $('spKeys').addEventListener('change', e => { SET.keys = e.target.checked; saveSet(); });
  $('spInk').addEventListener('change', e => { SET.inkShow = e.target.checked; saveSet(); drawInk(); });
  $('spFinger').addEventListener('change', e => { SET.fingerInk = e.target.checked; saveSet(); });
}
function closePop(){ popEl.hidden = true; }
document.addEventListener('pointerdown', e => { if(!popEl.hidden && !popEl.contains(e.target) && !e.target.closest('.score-tools')) closePop(); });

/* ================= editor ================= */
function openEditor(){
  if(!cur) return;
  editorOpen = true; closePop();
  editorEl.hidden = false;
  renderTools(); renderEditor();
}
function closeEditor(silent){
  if(!editorOpen) return;
  closePreview(); if(drag) dragEnd(true);
  editorOpen = false; editorEl.hidden = true; editorEl.innerHTML = '';
  if(silent === true) return;
  if(cur){
    savePiece(cur, true);
    const st = steps(cur);
    pi = Math.min(pi, Math.max(0, cur.pages.length - 1)); si = Math.min(si, Math.max(0, st.length - 1));
    renderTools(); renderReaderChrome(); renderStrip(); show();
  }
}
function orderText(p){ return p.steps ? steps(p).map(s => pageNo(p, s.pid)).join(' ') : ''; }

function renderEditor(){
  const p = cur; if(!p) return;
  const keepScroll = editorEl.querySelector('.sc-ebody'); const top = keepScroll ? keepScroll.scrollTop : 0;
  editorEl.innerHTML = `
    <div class="sc-ehead">
      <input id="edName" type="text" aria-label="曲名" placeholder="曲名" enterkeyhint="done" autocomplete="off">
      <button class="sc-btn primary" id="edDone">完成</button>
    </div>
    <div class="sc-ebody">
      <section class="card">
        <h2>頁面 <span class="sp"></span>
          <button class="sc-btn" id="edSort">依檔名排序</button>
          <button class="sc-btn" id="edAdd">＋ 加入頁面</button></h2>
        <p class="sc-help">點一下縮圖可以放大看，也可以在那裡裁切。按住縮圖約半秒後拖曳，可以調整順序；也可以用 ◀ ▶ 一格一格移動。⟳ 旋轉、✕ 刪除這一頁。</p>
        <div class="sc-pages" id="edPages"></div>
      </section>
      <section class="card">
        <h2>演奏順序</h2>
        <p class="sc-help">照彈奏時要翻到的頁碼依序填寫。例如有反覆、第一次和第二次結尾不同：<b>1 2 3 1 2 4</b>，也可以寫成 <b>1-3, 1-2, 4</b>。留空＝照上面的頁面順序。</p>
        <div class="sc-order">
          <input id="edOrder" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="留空＝照頁面順序" enterkeyhint="done">
          <button class="sc-btn" id="edClear">清空</button>
        </div>
        <div class="sc-err" id="edErr"></div>
        <div class="sc-pagebtns" id="edPageBtns"></div>
        <div class="sc-steps" id="edSteps"></div>
        <p class="sc-help" id="edBarsHelp" style="margin-top:10px"></p>
      </section>
      <section class="card">
        <h2>節拍器設定</h2>
        <div class="sc-row"><span class="txt" id="edTempo"></span>
          <button class="sc-btn" id="edTempoSave">記住目前的節拍器設定</button>
          <button class="sc-btn" id="edTempoClear">清除</button></div>
        <p class="sc-help" style="margin:10px 0 0">記住之後，每次打開這首曲子，節拍器會自動換成這個速度、拍號、重音和細分拍。</p>
      </section>
      <section class="card">
        <div class="sc-row"><span class="txt">把這首曲子（含頁面、設定、筆記）存成備份檔。</span><button class="sc-btn" id="edExport">匯出這首曲子</button></div>
      </section>
      <section class="card">
        <div class="sc-row"><span class="txt">刪除這首曲子和它的所有頁面、筆記。</span><button class="sc-btn danger" id="edDelete">刪除曲子</button></div>
      </section>
    </div>`;
  const nameIn = $('edName'); nameIn.value = p.name;
  nameIn.addEventListener('input', () => { p.name = nameIn.value.trim() || '未命名'; savePiece(p); });
  nameIn.addEventListener('keydown', e => { if(e.key === 'Enter') nameIn.blur(); });
  $('edDone').addEventListener('click', () => closeEditor());
  $('edAdd').addEventListener('click', () => pickFiles(p));
  $('edSort').addEventListener('click', () => {
    p.pages.sort((a, b) => collator.compare(a.name || '', b.name || '') || a.n - b.n);
    savePiece(p); renderPages(); renderOrder(true);
  });
  $('edClear').addEventListener('click', () => { setSteps(p, null); renderOrder(true); });
  $('edTempoSave').addEventListener('click', () => { p.tempo = {bpm:S.bpm, meter:S.meter, accents:S.accents.slice(), subdiv:S.subdiv}; savePiece(p); renderTempo(); });
  $('edTempoClear').addEventListener('click', () => { p.tempo = null; savePiece(p); renderTempo(); });
  $('edExport').addEventListener('click', () => exportBackup([p], p.name));
  $('edDelete').addEventListener('click', async () => {
    if(!confirm(`刪除「${p.name}」？\n這首曲子的所有頁面都會從這台 iPad 刪除，無法復原。`)) return;
    const victim = p;
    closeEditor(true);
    closePiece();
    await deletePiece(victim);
    renderLib();
  });
  const orderIn = $('edOrder');
  orderIn.addEventListener('input', () => {
    const r = parseOrder(orderIn.value, p.pages.length);
    orderIn.classList.toggle('bad', !r.ok);
    $('edErr').textContent = r.ok ? '' : r.err;
    if(r.ok){ setSteps(p, r.list.length ? r.list : null); renderOrder(false); }
  });
  orderIn.addEventListener('blur', () => { if(!orderIn.classList.contains('bad')) orderIn.value = orderText(p); });
  orderIn.addEventListener('keydown', e => { if(e.key === 'Enter') orderIn.blur(); });
  renderPages(); renderOrder(true); renderTempo();
  editorEl.querySelector('.sc-ebody').scrollTop = top;
}

/* new step list from page numbers; bars carry over where the same page sits in the same step */
function setSteps(p, list){
  const old = steps(p);
  if(!list){
    p.pageBars = p.pageBars || {};
    if(p.steps) for(const s of old) if(s.bars && !p.pageBars[s.pid]) p.pageBars[s.pid] = s.bars;
    p.steps = null;
  }else{
    p.steps = list.map((no, i) => {
      const pid = p.pages[no - 1].id;
      const same = old[i] && old[i].pid === pid ? old[i] : null;
      return {pid, bars:same ? same.bars : ((old.find(s => s.pid === pid) || {}).bars || 0)};
    });
  }
  savePiece(p);
}

function renderTempo(){
  const t = cur && cur.tempo;
  $('edTempo').textContent = t ? `${METERS[t.meter] && METERS[t.meter].unit === 8 ? '♪' : '♩'} = ${t.bpm} · ${t.meter}` +
    (t.subdiv > 1 ? ' · ' + (SUBS.find(s => s.n === t.subdiv) || {}).label : '') : '未設定（打開這首曲子時不會更改節拍器）';
  $('edTempoClear').hidden = !t;
}

function renderOrder(setText){
  const p = cur, st = steps(p);
  if(setText){ const oi = $('edOrder'); oi.value = orderText(p); oi.classList.remove('bad'); $('edErr').textContent = ''; }
  const pb = $('edPageBtns'); pb.innerHTML = '';
  if(p.pages.length){
    pb.appendChild(h('span', 'lab', '點頁碼加到最後：'));
    p.pages.forEach((pg, k) => {
      const b = h('button', null, String(k + 1));
      b.addEventListener('click', () => { const l = st.map(s => pageNo(p, s.pid)); l.push(k + 1); setSteps(p, l); renderOrder(true); });
      pb.appendChild(b);
    });
    const back = h('button', null, '⌫'); back.setAttribute('aria-label', '刪除最後一步');
    back.addEventListener('click', () => { const l = st.map(s => pageNo(p, s.pid)); l.pop(); setSteps(p, l.length ? l : null); renderOrder(true); });
    pb.appendChild(back);
  }
  const box = $('edSteps'); box.innerHTML = '';
  st.forEach((s, i) => {
    const c = h('div', 'sc-stepc');
    c.innerHTML = `<span class="i">${i + 1}.</span><span class="p">頁 ${pageNo(p, s.pid)}</span>`;
    if(SET.autoFlip){
      const inp = h('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.value = s.bars || ''; inp.placeholder = '—';
      inp.setAttribute('aria-label', `第 ${i + 1} 步的小節數`);
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '').slice(0, 3);
        const v = parseInt(inp.value, 10) || 0;
        s.bars = v;                      // with a custom order, s is the step object stored in p.steps
        if(!p.steps){ p.pageBars = p.pageBars || {}; p.pageBars[s.pid] = v; }
        savePiece(p);
      });
      c.append(inp, h('span', 'u', '小節'));
    }
    if(p.steps){
      const x = h('button', null, '✕'); x.setAttribute('aria-label', `刪除第 ${i + 1} 步`);
      x.addEventListener('click', () => { const l = st.map(z => pageNo(p, z.pid)); l.splice(i, 1); setSteps(p, l.length ? l : null); renderOrder(true); });
      c.appendChild(x);
    }
    box.appendChild(c);
  });
  $('edBarsHelp').innerHTML = SET.autoFlip
    ? '每一步填「這一頁要彈幾小節」，節拍器數到就自動翻頁；沒填的那一步就手動翻。反覆時，同一頁在不同步可以填不同的小節數。'
    : '想跟著節拍器自動翻頁的話，按右上角 ⚙ 開啟「跟著節拍器自動翻頁」，這裡就可以填每一步的小節數。';
}

/* page thumbnails with drag-to-reorder */
let drag = null;
function renderPages(){
  killGhosts();
  const p = cur, box = $('edPages'); box.innerHTML = '';
  if(!p.pages.length){ box.innerHTML = '<p class="sc-help">沒有頁面，按「＋ 加入頁面」。</p>'; return; }
  p.pages.forEach((pg, k) => {
    const c = h('div', 'sc-pg'); c.dataset.k = k;
    const th = h('div', 'th'); setThumb(th, pg);
    const no = h('span', 'no', String(k + 1));
    const fn = h('div', 'fn'); fn.textContent = (pg.crop ? '✂ ' : '') + (pg.name || '') + (pg.of > 1 ? ` · p.${pg.n}` : '');
    const acts = h('div', 'acts');
    const mk = (t, lab, fnc, dis) => { const b = h('button', null, t); b.setAttribute('aria-label', lab); b.disabled = !!dis; if(dis) b.style.opacity = .3; b.addEventListener('click', fnc); return b; };
    acts.append(
      mk('◀', '往前移', () => movePage(k, k - 1), k === 0),
      mk('⟳', '旋轉', () => { pg.rot = (pg.rot + 90) % 360; if(pg.crop){ const c = pg.crop; pg.crop = {l:c.b, t:c.l, r:c.t, b:c.r}; } savePiece(p); renderPages(); }),
      mk('✕', '刪除這一頁', () => {
        if(!confirm(`刪除第 ${k + 1} 頁？`)) return;
        p.pages.splice(k, 1);
        DB.del('ink', pg.id).catch(() => {}); inkArr.delete(pg.id); inkMem.delete(pg.id);
        if(p.steps) p.steps = p.steps.filter(s => s.pid !== pg.id);
        if(p.steps && !p.steps.length) p.steps = null;
        savePiece(p); renderPages(); renderOrder(true);
      }),
      mk('▶', '往後移', () => movePage(k, k + 1), k === p.pages.length - 1));
    c.append(th, no, fn, acts);
    c.addEventListener('pointerdown', e => startDrag(e, c, k));
    box.appendChild(c);
  });
}
function movePage(from, to){
  const p = cur; if(to < 0 || to >= p.pages.length || from === to) return;
  const [m] = p.pages.splice(from, 1); p.pages.splice(to, 0, m);
  savePiece(p); renderPages(); renderOrder(true);
}
/* Drag: press and hold a thumbnail, then move. A short tap opens the page large (preview).
   Every way a touch can end (lift, cancel, a second finger, the app going to the background) cleans up the
   floating copy, so it can never be left stuck on screen. */
function killGhosts(){
  document.querySelectorAll('.sc-ghost').forEach(g => g.remove());
  document.querySelectorAll('.sc-pg.drag, .sc-pg.target').forEach(c => c.classList.remove('drag', 'target'));
}
function startDrag(e, card, k){
  if(e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if(drag){ dragEnd(true); return; }            // a second finger: cancel, do nothing
  killGhosts();
  const sx = e.clientX, sy = e.clientY;
  const d = {k, card, sx, sy, x:sx, y:sy, on:false, target:-1, timer:0, ghost:null, t0:performance.now()};
  d.timer = setTimeout(() => {
    if(drag !== d || !card.isConnected) return;
    d.on = true;
    const g = card.cloneNode(true); g.classList.add('sc-ghost'); g.style.left = d.x + 'px'; g.style.top = d.y + 'px';
    document.body.appendChild(g); d.ghost = g; card.classList.add('drag');
  }, e.pointerType === 'mouse' ? 150 : 450);
  drag = d;
}
function dragMove(x, y){
  const d = drag; if(!d) return false;
  d.x = x; d.y = y;
  if(!d.on){ if(Math.hypot(x - d.sx, y - d.sy) > 10){ clearTimeout(d.timer); drag = null; } return false; }
  if(!d.ghost || !d.ghost.isConnected){ dragEnd(true); return false; }
  d.ghost.style.left = x + 'px'; d.ghost.style.top = y + 'px';
  d.ghost.style.display = 'none';
  const under = document.elementFromPoint(x, y); d.ghost.style.display = '';
  const t = under && under.closest('.sc-pg');
  const nk = t && t !== d.card && !t.classList.contains('sc-ghost') ? +t.dataset.k : -1;
  if(nk !== d.target){
    document.querySelectorAll('.sc-pg.target').forEach(z => z.classList.remove('target'));
    if(nk >= 0) t.classList.add('target');
    d.target = nk;
  }
  const body = editorEl.querySelector('.sc-ebody');
  if(body){ const r = body.getBoundingClientRect(); if(y < r.top + 50) body.scrollTop -= 12; else if(y > r.bottom - 50) body.scrollTop += 12; }
  return true;
}
function dragEnd(cancel){
  const d = drag; drag = null;
  killGhosts();
  if(!d) return;
  clearTimeout(d.timer);
  if(!d.on){                                   // a short tap on the thumbnail: show the page large
    if(!cancel && performance.now() - d.t0 < 600 && Math.hypot(d.x - d.sx, d.y - d.sy) < 10) openPreview(d.k);
    return;
  }
  if(!cancel && d.target >= 0) movePage(d.k, d.target);
}
document.addEventListener('pointermove', e => { if(drag && e.pointerType !== 'touch') dragMove(e.clientX, e.clientY); });
document.addEventListener('pointerup', e => { if(drag && e.pointerType !== 'touch') dragEnd(false); });
document.addEventListener('pointercancel', e => { if(drag && e.pointerType !== 'touch') dragEnd(true); });
// touch: use touch events so that once a drag has started the list does not scroll underneath it
document.addEventListener('touchmove', e => {
  if(!drag) return;
  if(e.touches.length > 1){ dragEnd(true); return; }
  const t = e.touches[0];
  if(dragMove(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
}, {passive:false});
document.addEventListener('touchend', e => { if(drag){ if(e.touches.length === 0) dragEnd(false); } else killGhosts(); });
document.addEventListener('touchcancel', () => dragEnd(true));
document.addEventListener('visibilitychange', () => { if(drag) dragEnd(true); });
window.addEventListener('blur', () => { if(drag) dragEnd(true); });

/* ---------- page preview (tap a thumbnail in the editor), with cropping ---------- */
const pvEl = h('div', 'sc-pv'); pvEl.hidden = true;
pvEl.innerHTML = `
  <div class="sc-pv-top">
    <span class="sc-pv-title" id="pvTitle"></span>
    <button class="sc-btn nav-only" id="pvCrop">✂ 裁切</button>
    <button class="sc-btn nav-only" id="pvClose">✕ 關閉</button>
    <span class="sc-pv-hint crop-only">拖曳框線或四個角，切掉不要的空白</span>
  </div>
  <div class="sc-pv-stage" id="pvStage"></div>
  <div class="sc-pv-bot nav-only">
    <button class="sc-btn" id="pvPrev">‹ 上一頁</button>
    <span class="sp"></span>
    <button class="sc-btn" id="pvBack">◀ 往前移</button>
    <button class="sc-btn" id="pvFwd">往後移 ▶</button>
    <span class="sp"></span>
    <button class="sc-btn" id="pvNext">下一頁 ›</button>
  </div>
  <div class="sc-pv-bot crop-only">
    <button class="sc-btn" id="pvAuto">自動去白邊</button>
    <button class="sc-btn" id="pvUncrop">不裁切</button>
    <span class="sp"></span>
    <button class="sc-btn" id="pvCancel">取消</button>
    <button class="sc-btn primary" id="pvDone">完成</button>
  </div>`;
document.body.appendChild(pvEl);
let pvK = -1, pvTok = 0, pvCrop = null;     // pvCrop: crop being edited {l,t,r,b} (fractions of the rotated page), null = not cropping
function openPreview(k){ if(!cur || !cur.pages[k]) return; pvK = k; pvCrop = null; pvEl.hidden = false; renderPreview(); }
function closePreview(){
  if(pvEl.hidden) return;
  pvEl.hidden = true; pvTok++; pvCrop = null; pvEl.classList.remove('cropping');
  $('pvStage').querySelectorAll('canvas').forEach(freeCanvas); $('pvStage').innerHTML = '';
}
function renderPreview(){
  const p = cur, pg = p && p.pages[pvK];
  if(!pg){ closePreview(); return; }
  const N = p.pages.length, cropping = !!pvCrop;
  pvEl.classList.toggle('cropping', cropping);
  $('pvTitle').textContent = `第 ${pvK + 1} / ${N} 頁 · ${pg.name || ''}${pg.of > 1 ? ' p.' + pg.n : ''}${pg.crop ? ' · 已裁切' : ''}`;
  $('pvPrev').disabled = pvK === 0; $('pvNext').disabled = pvK === N - 1;
  $('pvBack').disabled = pvK === 0; $('pvFwd').disabled = pvK === N - 1;
  const box = $('pvStage'), tok = ++pvTok;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pad = cropping ? 24 : 0;          // room around the page for the crop handles
  const W = Math.floor((box.clientWidth - pad * 2) * dpr), H = Math.floor((box.clientHeight - pad * 2) * dpr);
  box.querySelectorAll('canvas').forEach(freeCanvas);
  if(!cropping){
    const ph = h('img'); ph.alt = ''; box.replaceChildren(ph);
    thumb(pg).then(u => { if(tok === pvTok && box.firstChild === ph) ph.src = u; }).catch(() => {});
  }else box.replaceChildren();
  enqueue('pv:' + pageKey(pg, W, H) + (cropping ? ':full' : ''), () => drawPage(pg, W, H, cropping), true).then(c => {
    if(tok !== pvTok){ freeCanvas(c); return; }
    c.style.width = (c.width / dpr) + 'px'; c.style.height = (c.height / dpr) + 'px';
    if(!cropping){ box.replaceChildren(c); return; }
    const wrap = h('div', 'sc-crop-wrap'); wrap.appendChild(c);
    const cb = h('div', 'sc-cropbox');
    for(const k of ['t', 'b', 'l', 'r', 'tl', 'tr', 'bl', 'br']){ const hd = h('div', 'hd ' + k); hd.dataset.h = k; cb.appendChild(hd); }
    wrap.appendChild(cb);
    box.replaceChildren(wrap);
    placeCropBox();
  }).catch(() => {});
}
function placeCropBox(){
  const cb = pvEl.querySelector('.sc-cropbox'); if(!cb || !pvCrop) return;
  const {l, t, r, b} = pvCrop;
  cb.style.left = (l * 100) + '%'; cb.style.top = (t * 100) + '%'; cb.style.right = (r * 100) + '%'; cb.style.bottom = (b * 100) + '%';
}
function pvGo(d){ if(pvCrop) return; const n = pvK + d; if(cur && n >= 0 && n < cur.pages.length){ pvK = n; renderPreview(); } }
function pvMove(d){
  const to = pvK + d; if(!cur || to < 0 || to >= cur.pages.length) return;
  const [m] = cur.pages.splice(pvK, 1); cur.pages.splice(to, 0, m); pvK = to;
  savePiece(cur); renderPages(); renderOrder(true); renderPreview();
}
function startCrop(){
  const pg = cur && cur.pages[pvK]; if(!pg) return;
  pvCrop = Object.assign({l:0, t:0, r:0, b:0}, pg.crop || {});
  renderPreview();
}
function finishCrop(save){
  const pg = cur && cur.pages[pvK];
  if(save && pg){
    const c = {}; let any = false;
    for(const k of ['l', 't', 'r', 'b']){ const v = Math.round(pvCrop[k] * 1e4) / 1e4; c[k] = v < 0.002 ? 0 : v; if(c[k]) any = true; }
    if(any) pg.crop = c; else delete pg.crop;
    savePiece(cur); renderPages();
  }
  pvCrop = null; renderPreview();
}
// find the printed area: anything clearly darker than the paper. Works for scans and PDFs; photos with a dark
// table around the paper keep their edges (adjust those by hand).
async function autoCrop(){
  const pg = cur && cur.pages[pvK]; if(!pg || !pvCrop) return;
  const c = await enqueue('auto:' + pg.id, () => drawPage(pg, 900, 900, true), true);
  const w = c.width, hh = c.height, px = c.getContext('2d').getImageData(0, 0, w, hh).data;
  freeCanvas(c);
  const lum = new Uint8Array(w * hh), hist = new Uint32Array(256);
  for(let i = 0, j = 0; i < lum.length; i++, j += 4){ const v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000 | 0; lum[i] = v; hist[v]++; }
  let acc = 0, paper = 255;                                   // paper = brightness that 60% of pixels reach
  for(let v = 255; v >= 0; v--){ acc += hist[v]; if(acc >= lum.length * 0.6){ paper = v; break; } }
  const ink = paper * 0.72;
  const rows = new Uint32Array(hh), cols = new Uint32Array(w);
  for(let y = 0; y < hh; y++) for(let x = 0; x < w; x++) if(lum[y * w + x] < ink){ rows[y]++; cols[x]++; }
  const rMin = Math.max(2, w * 0.004), cMin = Math.max(2, hh * 0.004);
  let t = 0, b = hh - 1, l = 0, r = w - 1;
  while(t < hh && rows[t] < rMin) t++;
  while(b > t && rows[b] < rMin) b--;
  while(l < w && cols[l] < cMin) l++;
  while(r > l && cols[r] < cMin) r--;
  if(t >= b || l >= r){ return; }
  const px2 = 0.02;                                           // keep a little margin
  pvCrop = {l:Math.max(0, l / w - px2), t:Math.max(0, t / hh - px2), r:Math.max(0, (w - 1 - r) / w - px2), b:Math.max(0, (hh - 1 - b) / hh - px2)};
  placeCropBox();
}
$('pvClose').addEventListener('click', closePreview);
$('pvPrev').addEventListener('click', () => pvGo(-1));
$('pvNext').addEventListener('click', () => pvGo(1));
$('pvBack').addEventListener('click', () => pvMove(-1));
$('pvFwd').addEventListener('click', () => pvMove(1));
$('pvCrop').addEventListener('click', startCrop);
$('pvCancel').addEventListener('click', () => finishCrop(false));
$('pvDone').addEventListener('click', () => finishCrop(true));
$('pvUncrop').addEventListener('click', () => { if(pvCrop){ pvCrop = {l:0, t:0, r:0, b:0}; placeCropBox(); } });
$('pvAuto').addEventListener('click', () => { autoCrop().catch(e => console.error(e)); });
document.addEventListener('keydown', e => {
  if(pvEl.hidden) return;
  if(e.key === 'Escape'){ if(pvCrop) finishCrop(false); else closePreview(); }
  else if(e.key === 'ArrowLeft') pvGo(-1);
  else if(e.key === 'ArrowRight') pvGo(1);
  else if(e.key === 'Enter' && pvCrop) finishCrop(true);
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
{ // swipe to turn pages; in crop mode, drag the crop handles
  let sx = 0, sy = 0, on = false, hd = null;
  const st = $('pvStage');
  st.addEventListener('pointerdown', e => {
    const handle = pvCrop && e.target.closest('.hd');
    if(handle){
      const wrap = handle.closest('.sc-crop-wrap').getBoundingClientRect();
      hd = {k:handle.dataset.h, x:e.clientX, y:e.clientY, w:wrap.width, h:wrap.height, c0:{...pvCrop}, id:e.pointerId};
      try{ st.setPointerCapture(e.pointerId); }catch(err){}
      e.preventDefault(); return;
    }
    sx = e.clientX; sy = e.clientY; on = !pvCrop;
  });
  st.addEventListener('pointermove', e => {
    if(!hd || e.pointerId !== hd.id) return;
    const dx = (e.clientX - hd.x) / hd.w, dy = (e.clientY - hd.y) / hd.h, c0 = hd.c0, c = pvCrop, MIN = 0.15;
    const cl = (v, max) => Math.min(Math.max(0, v), Math.max(0, max));
    if(hd.k.includes('l')) c.l = cl(c0.l + dx, 1 - c.r - MIN);
    if(hd.k.includes('r')) c.r = cl(c0.r - dx, 1 - c.l - MIN);
    if(hd.k.includes('t')) c.t = cl(c0.t + dy, 1 - c.b - MIN);
    if(hd.k.includes('b')) c.b = cl(c0.b - dy, 1 - c.t - MIN);
    placeCropBox();
  });
  const end = e => {
    if(hd && e.pointerId === hd.id){ hd = null; return; }
    if(!on) return; on = false;
    if(e.type !== 'pointerup') return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) pvGo(dx < 0 ? 1 : -1);
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('gesturestart', e => e.preventDefault());
}
let pvResize = 0;
window.addEventListener('resize', () => { if(!pvEl.hidden){ clearTimeout(pvResize); pvResize = setTimeout(renderPreview, 150); } });
document.addEventListener('contextmenu', e => { if(drag || e.target.closest('.sc-pg') || e.target.closest('.sc-stage')) e.preventDefault(); });

/* ================= 備份 (backup to a file, restore from it) =================
   One .mtbk file: "MTBK" + version (uint32 LE) + header length (uint32 LE) + header JSON + the original files.
   header = {app, v, created, pieces:[piece records], files:[{id, pieceId, name, type, kind, count, off, len}], ink:{pid:strokes}} */
function dialog(msg, buttons){
  const d = h('div', 'sc-dlg'), box = h('div', 'sc-dlg-box'), p = h('p'), row = h('div', 'sc-dlg-row');
  p.textContent = msg; box.append(p, row); d.appendChild(box);
  for(const b of buttons){
    const el = h('button', 'sc-btn' + (b.primary ? ' primary' : ''), esc(b.label));
    el.addEventListener('click', () => { d.remove(); if(b.run) b.run(); });
    row.appendChild(el);
  }
  document.body.appendChild(d);
}
const fmtSize = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };

async function buildBackup(list){
  await flushInk();
  for(const p of list) await savePiece(p, true);
  const files = [], parts = [], ink = {};
  let off = 0;
  for(let i = 0; i < list.length; i++){
    const p = list[i];
    busy(`準備備份… ${i + 1} / ${list.length}`);
    for(const id of [...new Set(p.pages.map(x => x.file))]){
      const f = await DB.get('files', id).catch(() => null);
      if(!f) continue;
      files.push({id:f.id, pieceId:p.id, name:f.name, type:f.type, kind:f.kind, count:f.count, off, len:f.data.byteLength});
      parts.push(new Blob([f.data])); off += f.data.byteLength;
    }
    for(const pg of p.pages){
      const r = await DB.get('ink', pg.id).catch(() => null);
      if(r && r.s && r.s.length) ink[pg.id] = r.s;
    }
  }
  const head = new TextEncoder().encode(JSON.stringify({app:'metronome-score', v:1, created:new Date().toISOString(), pieces:list, files, ink}));
  const pre = new Uint8Array(12), dv = new DataView(pre.buffer);
  pre.set([77, 84, 66, 75]); dv.setUint32(4, 1, true); dv.setUint32(8, head.length, true);
  return new Blob([pre, head, ...parts], {type:'application/octet-stream'});
}
async function exportBackup(list, name){
  if(!list.length) return;
  let blob;
  try{ blob = await buildBackup(list); }
  catch(e){ console.error(e); alert('備份失敗：' + (e && e.message || e)); return; }
  finally{ busy(null); }
  const file = new File([blob], `${name.replace(/[\\/:*?"<>|]/g, '_')}-${ymd()}.mtbk`, {type:'application/octet-stream'});
  dialog(`備份檔已準備好（${list.length} 首，${fmtSize(blob.size)}）。\n按「儲存」後選「儲存到檔案」，存到 iCloud 雲碟或「我的 iPad」。`,
    [{label:'取消'}, {label:'儲存', primary:true, run:() => saveFile(file)}]);
}
function saveFile(file){
  try{
    if(navigator.canShare && navigator.canShare({files:[file]})){
      navigator.share({files:[file]}).catch(e => { if(!e || e.name !== 'AbortError') download(file); });
      return;
    }
  }catch(e){}
  download(file);
}
function download(file){
  const u = URL.createObjectURL(file), a = h('a');
  a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

const bkInput = h('input'); bkInput.type = 'file'; bkInput.style.display = 'none';   // no accept filter: iPadOS would grey out .mtbk
document.body.appendChild(bkInput);
bkInput.addEventListener('change', () => { const f = bkInput.files[0]; bkInput.value = ''; if(f) importBackup(f); });
function pickBackup(){ bkInput.value = ''; bkInput.click(); }

async function importBackup(file){
  let H, base;
  try{
    const dv = new DataView(await file.slice(0, 12).arrayBuffer());
    if(file.size < 12 || dv.getUint32(0, false) !== 0x4D54424B) throw new Error('not a backup');
    const hl = dv.getUint32(8, true);
    H = JSON.parse(new TextDecoder().decode(await file.slice(12, 12 + hl).arrayBuffer()));
    base = 12 + hl;
    if(!H || H.app !== 'metronome-score' || !Array.isArray(H.pieces)) throw new Error('not a backup');
  }catch(e){ alert('這不是樂譜的備份檔（.mtbk）。'); return 0; }
  const dup = H.pieces.filter(p => pieces.some(x => x.id === p.id));
  let replace = false;
  if(dup.length) replace = confirm(`備份裡有 ${dup.length} 首曲子已經在曲庫裡。\n\n按「確定」：用備份取代它們（頁面、設定、筆記都換成備份裡的）。\n按「取消」：保留原本的，備份另外加成新的一份。`);
  let n = 0;
  try{
    for(const P0 of H.pieces){
      busy(`匯入備份… ${n + 1} / ${H.pieces.length}`);
      const exists = pieces.find(x => x.id === P0.id);
      const copy = !!exists && !replace;
      if(exists && replace){ if(cur && cur.id === exists.id) closePiece(); await deletePiece(exists); }
      const P = JSON.parse(JSON.stringify(P0)), fmap = {}, pmap = {};
      if(copy){ P.id = uid(); P.name = P0.name + '（副本）'; }
      for(const f of H.files.filter(f => f.pieceId === P0.id)){
        const id = copy ? uid() : f.id; fmap[f.id] = id;
        const data = await file.slice(base + f.off, base + f.off + f.len).arrayBuffer();
        await DB.put('files', {id, pieceId:P.id, name:f.name, type:f.type, kind:f.kind, count:f.count, data});
      }
      P.pages = (P.pages || []).map(pg => { const id = copy ? uid() : pg.id; pmap[pg.id] = id; return Object.assign({}, pg, {id, file:fmap[pg.file] || pg.file}); });
      if(P.steps) P.steps = P.steps.map(s => Object.assign({}, s, {pid:pmap[s.pid] || s.pid}));
      if(P.pageBars){ const nb = {}; for(const k in P.pageBars) nb[pmap[k] || k] = P.pageBars[k]; P.pageBars = nb; }
      for(const old in pmap){ const s = H.ink && H.ink[old]; if(s && s.length) await DB.put('ink', {s}, pmap[old]); }
      P.opened = Date.now();
      await DB.put('pieces', P);
      pieces.push(P); n++;
    }
  }catch(e){ console.error(e); alert('匯入時發生錯誤：' + (e && e.message || e) + `\n已匯入 ${n} 首。`); }
  finally{ busy(null); }
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); }catch(e){}
  if(!cur) renderLib();
  if(n) note2(`已從備份匯入 ${n} 首曲子`);
  return n;
}
function note2(t){ dialog(t, [{label:'好', primary:true}]); }

/* ================= init ================= */
(async () => {
  renderMini();
  $('scInkSlot').replaceWith(inkBar);
  await loadPieces();
  renderLib(); renderTools();
  if(UI.piece && pieces.some(p => p.id === UI.piece)) await openPiece(UI.piece);
  setTab(UI.tab === 'score' ? 'score' : 'metro');
  requestAnimationFrame(frame2);
})();

window.__score = {importFiles, openPiece, buildBackup, importBackup, exportBackup, inkArr, undoInk, redoInk, get undoN(){ return undoS.length; }, closePiece, parseOrder, setMode, go, steps, openEditor, closeEditor,
  get mem(){ return {files:fileCache.size, urls:urlCache.size, pages:pageCache.size}; }, get pvCrop(){ return pvCrop; },
  get cur(){ return cur; }, get state(){ return {mode, pi, si, tab, af:{...AF}, cache:pageCache.size}; }, SET, AF};
})();
