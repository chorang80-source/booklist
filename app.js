'use strict';
/* 내 독서노트 — 서버/계정 없이 브라우저에만 저장되는 PWA */

const KEY = 'booklist.v1';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/* ---------- 저장소 ---------- */
let db = { books: [] };
try { db = JSON.parse(localStorage.getItem(KEY)) || db; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { toast('저장 공간이 부족해요'); } };
const book = id => db.books.find(b => b.id === id);

function status(b) {
  if (b.done || (b.pages && b.page >= b.pages)) return 'done';
  return b.page > 0 ? 'reading' : 'want';
}
const STATUS_LABEL = { want: '읽고 싶은', reading: '읽는 중', done: '완독' };
const pct = b => b.pages ? Math.min(100, Math.round(b.page / b.pages * 100)) : (b.done ? 100 : 0);

/* ---------- UI 유틸 ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200);
}
function openSheet(html) { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; return $('#sheet-body'); }
function closeSheet() { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; stopCamera(); }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

/* ---------- 라우팅 ---------- */
let tab = 'library', openId = null, filter = 'all', quoteQuery = '';
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; openId = null; render(); });
$('#btn-back').onclick = () => { openId = null; render(); };

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#btn-back').hidden = !openId;
  const v = $('#view');
  if (openId && book(openId)) return renderBook(v, book(openId));
  openId = null; $('#btn-back').hidden = true;
  if (tab === 'library') renderLibrary(v);
  else if (tab === 'add') renderAdd(v);
  else renderQuotes(v);
  window.scrollTo(0, 0);
}

/* ---------- 서재 ---------- */
const coverHtml = b => b.cover
  ? `<img class="cover" src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=cover>${esc(b.title).slice(0,14)}</div>'">`
  : `<div class="cover">${esc(b.title).slice(0, 14)}</div>`;

function renderLibrary(v) {
  $('#title').textContent = '내 서재';
  const counts = { all: db.books.length, reading: 0, want: 0, done: 0 };
  db.books.forEach(b => counts[status(b)]++);
  const list = db.books.filter(b => filter === 'all' || status(b) === filter)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const chip = (k, l) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${l} ${counts[k]}</button>`;
  v.innerHTML = `
    <div class="chips">${chip('all', '전체')}${chip('reading', '읽는 중')}${chip('want', '읽고 싶은')}${chip('done', '완독')}</div>
    ${list.length ? list.map(b => `
      <div class="book" data-id="${b.id}">
        ${coverHtml(b)}
        <div class="info">
          <h3>${esc(b.title)}</h3>
          <p>${esc(b.authors)}</p>
          <div class="bar"><i style="width:${pct(b)}%"></i></div>
          <div class="pct">${STATUS_LABEL[status(b)]}${b.pages ? ` · ${b.page}/${b.pages}쪽` : ''} · ${pct(b)}%${b.quotes.length ? ` · 구절 ${b.quotes.length}` : ''}</div>
        </div>
      </div>`).join('')
      : `<div class="empty"><b>📖</b>${db.books.length ? '이 분류에는 책이 없어요' : '아직 책이 없어요.<br>아래 “책 추가”에서 제목만 입력하거나<br>바코드를 스캔해 보세요.'}</div>`}
    <div class="row" style="margin-top:20px">
      <button class="btn ghost" id="exp">백업 내보내기</button>
      <button class="btn ghost" id="imp">백업 가져오기</button>
    </div>`;
  v.querySelectorAll('.chip').forEach(c => c.onclick = () => { filter = c.dataset.f; render(); });
  v.querySelectorAll('.book').forEach(c => c.onclick = () => { openId = c.dataset.id; render(); });
  $('#exp').onclick = exportData; $('#imp').onclick = importData;
}

function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `독서노트-백업-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData() {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json';
  i.onchange = async () => {
    try {
      const d = JSON.parse(await i.files[0].text());
      if (!Array.isArray(d.books)) throw 0;
      if (!confirm(`책 ${d.books.length}권을 가져옵니다. 현재 데이터는 덮어써져요.`)) return;
      db = d; save(); render(); toast('가져왔어요');
    } catch { toast('올바른 백업 파일이 아니에요'); }
  };
  i.click();
}

/* ---------- 책 검색 (Google Books → 실패 시 Open Library) ---------- */
const PROXY = (window.BOOK_PROXY || '').replace(/\/$/, '');
const isIsbn = s => /^\d{10}(\d{3})?$/.test(s.replace(/[-\s]/g, ''));

// 카카오 도서(중계 서버 경유): 한국 책에 가장 정확 (쪽수는 제공되지 않음)
async function searchKakao(q) {
  if (!PROXY) return [];
  const url = isIsbn(q) ? `${PROXY}/lookup?isbn=${q.replace(/\D/g, '')}` : `${PROXY}/search?q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error(r.status); // 중계가 막혀도 검색이 지연되지 않도록
  const j = await r.json();
  return Array.isArray(j) ? j : (j ? [j] : []);
}
async function searchBooks(q) {
  const [a, g] = await Promise.allSettled([searchKakao(q), searchGoogleOrOL(q)]);
  const out = [], seen = new Map();
  for (const r of [...(a.value || []), ...(g.value || [])]) {
    const k = r.isbn || r.title + r.authors;
    if (seen.has(k)) { // 같은 책이면 빠진 정보(쪽수·표지)를 다른 출처에서 보충
      const o = seen.get(k); o.pages ||= r.pages; o.cover ||= r.cover; continue;
    }
    seen.set(k, r); out.push(r);
  }
  if (!out.length && a.status === 'rejected' && g.status === 'rejected') throw new Error('search');
  return out;
}
async function searchGoogleOrOL(q) {
  q = q.trim();
  const isbn = q.replace(/[-\s]/g, '');
  const query = isIsbn(q) ? 'isbn:' + isbn : q;
  try {
    const r = await fetch('https://www.googleapis.com/books/v1/volumes?maxResults=20&printType=books&q=' + encodeURIComponent(query));
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const out = (j.items || []).map(it => {
      const i = it.volumeInfo || {};
      const ids = i.industryIdentifiers || [];
      const isbn13 = (ids.find(x => x.type === 'ISBN_13') || ids[0] || {}).identifier || '';
      let cover = (i.imageLinks || {}).thumbnail || '';
      cover = cover.replace('http://', 'https://').replace('&edge=curl', '').replace('zoom=1', 'zoom=2');
      return { title: i.title + (i.subtitle ? ' ' + i.subtitle : ''), authors: (i.authors || []).join(', '),
        publisher: i.publisher || '', pages: i.pageCount || 0, cover, isbn: isbn13, desc: i.description || '' };
    });
    if (out.length) return out;
  } catch {}
  // 대체 검색
  const r = await fetch('https://openlibrary.org/search.json?limit=20&fields=title,author_name,cover_i,number_of_pages_median,isbn,publisher&' +
    (query.startsWith('isbn:') ? 'isbn=' + isbn : 'q=' + encodeURIComponent(q)));
  const j = await r.json();
  return (j.docs || []).map(d => ({
    title: d.title, authors: (d.author_name || []).join(', '), publisher: ((d.publisher || [])[0] || '').replace(/^Unknown$/i, ''),
    pages: d.number_of_pages_median || 0, isbn: (d.isbn || [])[0] || '', desc: '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : ''
  }));
}

function addBook(r) {
  const dup = db.books.find(b => (r.isbn && b.isbn === r.isbn) || (b.title === r.title && b.authors === r.authors));
  if (dup) { toast('이미 서재에 있는 책이에요'); return dup; }
  const b = { id: uid(), title: r.title, authors: r.authors, publisher: r.publisher, pages: r.pages || 0,
    cover: r.cover, isbn: r.isbn, desc: r.desc, page: 0, done: false, added: Date.now(), updated: Date.now(), quotes: [] };
  db.books.push(b); save(); toast('서재에 담았어요'); return b;
}

let lastResults = [];
function renderAdd(v) {
  $('#title').textContent = '책 추가';
  v.innerHTML = `
    <input type="search" id="q" placeholder="제목, 저자 또는 ISBN" autocomplete="off" enterkeyhint="search">
    ${('BarcodeDetector' in window) ? '<button class="btn block" id="scan" style="margin-top:10px">📷 바코드로 한 번에 추가</button>' : ''}
    <div id="res" style="margin-top:14px"><div class="empty"><b>🔍</b>입력하면 자동으로 검색돼요.<br>표지·저자·쪽수는 자동으로 채워집니다.</div></div>
    ${PROXY ? '<div class="status" style="text-align:center">도서 정보 제공: 카카오 · 네이버 · Google Books · Open Library</div>' : ''}`;
  const q = $('#q'); let t, seq = 0;
  q.oninput = () => {
    clearTimeout(t);
    if (q.value.trim().length < 2) return;
    t = setTimeout(async () => {
      const my = ++seq; $('#res').innerHTML = '<div class="status"><span class="spin"></span>검색 중…</div>';
      try { lastResults = await searchBooks(q.value); } catch { lastResults = null; }
      if (my !== seq) return;
      showResults();
    }, 450);
  };
  if ($('#scan')) $('#scan').onclick = scanBarcode;
}
function showResults() {
  const el = $('#res'); if (!el) return;
  if (lastResults === null) return el.innerHTML = '<div class="empty">검색에 실패했어요. 네트워크를 확인해 주세요.</div>';
  if (!lastResults.length) return el.innerHTML = '<div class="empty">결과가 없어요. 다른 검색어를 써 보세요.</div>';
  el.innerHTML = lastResults.map((r, i) => {
    const has = db.books.some(b => (r.isbn && b.isbn === r.isbn) || (b.title === r.title && b.authors === r.authors));
    return `<div class="book" data-i="${i}">${coverHtml(r)}
      <div class="info"><h3>${esc(r.title)}</h3><p>${esc(r.authors)}${r.publisher ? ' · ' + esc(r.publisher) : ''}</p>
      <p>${r.pages ? r.pages + '쪽' : '쪽수 정보 없음'}</p></div>
      <span class="chip ${has ? '' : 'on'} add-mini">${has ? '✓ 담김' : '+ 담기'}</span></div>`;
  }).join('');
  el.querySelectorAll('.book').forEach(c => c.onclick = () => {
    const b = addBook(lastResults[c.dataset.i]);
    if (b && c.querySelector('.add-mini').textContent.includes('담기')) showResults();
  });
}

/* ---------- 바코드(ISBN) 스캔 ---------- */
let stream = null, scanning = false;
function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
async function scanBarcode() {
  const body = openSheet(`<h3>책 뒷면 바코드를 비춰 주세요</h3><video id="cam" playsinline muted></video>
    <div class="status" id="scanmsg">인식 중…</div><button class="btn ghost block" id="cancel">닫기</button>`);
  $('#cancel', body).onclick = closeSheet;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch { closeSheet(); return toast('카메라 권한이 필요해요'); }
  const video = $('#cam'); video.srcObject = stream; await video.play();
  const det = new BarcodeDetector({ formats: ['ean_13'] });
  scanning = true;
  while (scanning) {
    try {
      const codes = await det.detect(video);
      const c = codes.map(x => x.rawValue).find(x => /^97[89]\d{10}$/.test(x));
      if (c) {
        scanning = false; $('#scanmsg').innerHTML = '<span class="spin"></span>책 정보를 찾는 중…';
        const res = await searchBooks(c).catch(() => []);
        closeSheet();
        if (!res.length) { toast('책 정보를 찾지 못했어요. 제목으로 검색해 보세요'); return; }
        const b = addBook(res[0]); if (b) { tab = 'library'; openId = b.id; render(); }
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
}

/* ---------- 책 상세 · 진행률 · 구절 ---------- */
function renderBook(v, b) {
  $('#title').textContent = '책 상세';
  const total = b.pages;
  v.innerHTML = `
    <div class="hero">${coverHtml(b)}<div><h2>${esc(b.title)}</h2><p>${esc(b.authors)}</p>
      <p>${esc(b.publisher)}${total ? ' · ' + total + '쪽' : ''}</p></div></div>

    <div class="panel"><h4>독서 진행률 · ${STATUS_LABEL[status(b)]}</h4>
      <div class="big" id="pp">${pct(b)}%</div>
      <div class="bar"><i id="pbar" style="width:${pct(b)}%"></i></div>
      ${total ? `<input type="range" id="rng" min="0" max="${total}" value="${b.page}">
        <div class="status" id="pg">${b.page} / ${total}쪽</div>
        <div class="steps"><button data-d="10">+10</button><button data-d="30">+30</button><button data-d="100">+100</button><button id="fin">완독 ✓</button></div>`
      : `<div class="status">전체 쪽수를 알면 진행률이 자동 계산돼요.</div>
        <div class="row"><input type="number" id="tp" inputmode="numeric" placeholder="전체 쪽수"><button class="btn" id="tpb" style="flex:none">저장</button></div>
        <div class="steps"><button id="fin">완독 ✓</button></div>`}
    </div>

    <div class="panel"><h4>간직하고 싶은 구절 (${b.quotes.length})</h4>
      <div class="row"><button class="btn" id="shot">📷 사진으로 담기</button><button class="btn ghost" id="typ">✍️ 직접 쓰기</button></div>
      <div style="margin-top:12px">${b.quotes.length ? b.quotes.slice().reverse().map(q => quoteHtml(q)).join('') : '<div class="status">책 페이지를 촬영하면 글자를 자동으로 읽어 줘요.</div>'}</div>
    </div>
    <button class="btn danger block" id="del">서재에서 삭제</button>`;

  const upd = () => { b.updated = Date.now(); save(); };
  const rng = $('#rng');
  const paint = () => {
    $('#pp').textContent = pct(b) + '%'; $('#pbar').style.width = pct(b) + '%';
    if (rng) { rng.value = b.page; $('#pg').textContent = `${b.page} / ${total}쪽`; }
  };
  if (rng) {
    rng.oninput = () => { b.page = +rng.value; b.done = b.page >= total; paint(); };
    rng.onchange = upd;
    v.querySelectorAll('[data-d]').forEach(x => x.onclick = () => {
      b.page = Math.min(total, b.page + +x.dataset.d); b.done = b.page >= total; paint(); upd();
    });
  } else {
    $('#tpb').onclick = () => { const n = +$('#tp').value; if (n > 0) { b.pages = n; upd(); render(); } };
  }
  $('#fin').onclick = () => { b.done = true; if (b.pages) b.page = b.pages; upd(); toast('🎉 완독을 축하해요'); render(); };
  $('#shot').onclick = () => pickPhoto(b);
  $('#typ').onclick = () => quoteSheet(b, { text: '', page: b.page || '' });
  $('#del').onclick = () => { if (confirm('이 책과 저장된 구절이 모두 삭제돼요.')) { db.books = db.books.filter(x => x !== b); save(); openId = null; render(); } };
  bindQuoteActions(v, b);
}

function quoteHtml(q, withBook) {
  return `<div class="quote" data-q="${q.id}">${esc(q.text)}
    <small>${withBook ? esc(withBook.title) + ' · ' : ''}${q.page ? q.page + '쪽 · ' : ''}${new Date(q.at).toLocaleDateString('ko-KR')}</small>
    <div class="acts"><button data-a="copy">복사</button><button data-a="edit">수정</button><button data-a="del">삭제</button></div></div>`;
}
function bindQuoteActions(root, bookOrNull) {
  root.querySelectorAll('.quote').forEach(el => {
    const id = el.dataset.q;
    const b = bookOrNull || db.books.find(x => x.quotes.some(q => q.id === id));
    const q = b.quotes.find(x => x.id === id);
    el.querySelector('[data-a=copy]').onclick = async () => { try { await navigator.clipboard.writeText(`“${q.text}”\n— ${b.title}${q.page ? ', ' + q.page + '쪽' : ''}`); toast('복사했어요'); } catch { toast('복사할 수 없어요'); } };
    el.querySelector('[data-a=edit]').onclick = () => quoteSheet(b, q);
    el.querySelector('[data-a=del]').onclick = () => { if (confirm('이 구절을 삭제할까요?')) { b.quotes = b.quotes.filter(x => x !== q); save(); render(); } };
  });
}

function quoteSheet(b, q, note) {
  const editing = !!q.id;
  const body = openSheet(`<h3>${editing ? '구절 수정' : '구절 저장'}</h3>
    ${note ? `<div class="status">${note}</div>` : ''}
    <textarea id="qt" placeholder="구절을 입력하세요">${esc(q.text)}</textarea>
    <div class="row" style="margin:10px 0"><input type="number" id="qp" inputmode="numeric" placeholder="쪽수" value="${esc(q.page)}"></div>
    <div class="row"><button class="btn ghost" id="c">취소</button><button class="btn" id="s">저장</button></div>`);
  $('#c', body).onclick = closeSheet;
  $('#s', body).onclick = () => {
    const text = $('#qt', body).value.trim(); if (!text) return toast('내용이 비어 있어요');
    const page = +$('#qp', body).value || 0;
    if (editing) { q.text = text; q.page = page; } else b.quotes.push({ id: uid(), text, page, at: Date.now() });
    b.updated = Date.now(); save(); closeSheet(); render(); toast('구절을 저장했어요');
  };
}

/* ---------- 사진 → 텍스트 (Tesseract.js, 기기에서 처리) ---------- */
let tessLoading;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return tessLoading ||= new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = ok; s.onerror = () => { tessLoading = null; no(new Error('load')); };
    document.head.appendChild(s);
  });
}
async function prepImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const sc = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  const x = c.getContext('2d'); x.filter = 'grayscale(1) contrast(1.35)'; x.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
function cleanOcr(t) {
  return t.replace(/-\n(?=[a-z])/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\u0000')
    .replace(/\n/g, ' ').replace(/\u0000/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim();
}
function pickPhoto(b) {
  const inp = $('#photo'); inp.value = '';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const body = openSheet(`<h3>글자를 읽는 중…</h3><div class="status" id="ocrmsg"><span class="spin"></span>준비 중 (처음 한 번은 언어 데이터를 내려받아 1분쯤 걸려요)</div>
      <button class="btn ghost block" id="c">취소</button>`);
    let cancelled = false; $('#c', body).onclick = () => { cancelled = true; closeSheet(); };
    try {
      await loadTesseract();
      const img = await prepImage(f);
      const res = await Tesseract.recognize(img, 'kor+eng', {
        logger: m => { const el = $('#ocrmsg'); if (el && m.progress != null) el.innerHTML = `<span class="spin"></span>${m.status === 'recognizing text' ? '글자 인식' : '언어 데이터 준비'} ${Math.round(m.progress * 100)}%`; }
      });
      if (cancelled) return;
      const text = cleanOcr(res.data.text);
      quoteSheet(b, { text, page: b.page || '' }, text ? '인식된 내용을 확인하고 틀린 글자만 고쳐 주세요.' : '글자를 찾지 못했어요. 직접 입력하거나 더 가까이서 다시 찍어 보세요.');
    } catch { if (!cancelled) { closeSheet(); toast('글자 인식에 실패했어요. 네트워크를 확인해 주세요'); } }
  };
  inp.click();
}

/* ---------- 구절 모아보기 ---------- */
function renderQuotes(v) {
  $('#title').textContent = '간직한 구절';
  const all = db.books.flatMap(b => b.quotes.map(q => ({ q, b }))).sort((a, c) => c.q.at - a.q.at);
  v.innerHTML = `<input type="search" id="qs" placeholder="구절·책 제목 검색" value="${esc(quoteQuery)}">
    <div id="ql" style="margin-top:12px"></div>`;
  const draw = () => {
    const k = quoteQuery.trim().toLowerCase();
    const list = all.filter(({ q, b }) => !k || q.text.toLowerCase().includes(k) || b.title.toLowerCase().includes(k));
    $('#ql').innerHTML = list.length ? list.map(({ q, b }) => quoteHtml(q, b)).join('')
      : `<div class="empty"><b>✒️</b>${all.length ? '검색 결과가 없어요' : '아직 저장한 구절이 없어요.<br>책 상세에서 📷로 페이지를 찍어 보세요.'}</div>`;
    bindQuoteActions($('#ql'), null);
  };
  $('#qs').oninput = e => { quoteQuery = e.target.value; draw(); };
  draw();
}

/* ---------- 시작 ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
