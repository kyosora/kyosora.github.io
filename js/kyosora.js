/* kyosora 主題前端。設定由 layout 寫進 window.KY；沒有相依套件，mermaid、Giscus、繁簡字典都是用到才載入。 */
(() => {
  'use strict';

  const KY = window.KY || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  // 存取失敗（瀏覽器停用儲存、額度滿）不丟例外；set 回傳是否真的寫進去，需要確定的地方自己判斷
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) {
      try { localStorage.setItem(key, val); return localStorage.getItem(key) === val; } catch (e) { return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* 刪不掉也不影響畫面 */ } }
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const loadScript = (src, attrs = {}) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    Object.entries(attrs).forEach(([k, v]) => { if (v) s.setAttribute(k, v); });
    s.onload = resolve;
    s.onerror = () => reject(new Error('載入失敗：' + src));
    document.head.appendChild(s);
  });

  let toastTimer;
  const toast = msg => {
    let el = $('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 1800);
  };

  const copyText = async text => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 舊瀏覽器或沒有剪貼簿權限時的備援；備援也失敗就回 false，讓呼叫端顯示失敗提示
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      try {
        ta.select();
        return document.execCommand('copy');
      } catch (e2) {
        return false;
      } finally {
        ta.remove();
      }
    }
  };

  /* ---------- 深淺色 ---------- */

  const currentTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const themeListeners = [];
  const themeBtn = $('[data-action="theme"]');
  // 按鈕名稱要跟著繁簡切換，但繁簡模組在後面才建立：先直接寫，模組建好後換成 translator.setAttr
  let labelAttr = (el, a, s) => el.setAttribute(a, s);
  const syncThemeButton = theme => {
    if (themeBtn) labelAttr(themeBtn, 'aria-label', theme === 'dark' ? '切換淺色模式' : '切換深色模式');
  };

  const applyTheme = (theme, remember) => {
    document.documentElement.dataset.theme = theme;
    if (remember) store.set('ky-theme', theme);
    syncThemeButton(theme);
    themeListeners.forEach(fn => fn(theme));
  };
  // head 裡的小腳本已經在第一次繪製前決定好深淺色，這裡只把按鈕名稱對上
  syncThemeButton(currentTheme());

  // 手動選過的深淺色：本主題的 ky-theme 優先，其次是 Butterfly 時期還沒過期的 theme（{value, expiry}）。
  // 判斷規則跟 head 裡第一次繪製前的小腳本相同
  const savedTheme = () => {
    const t = store.get('ky-theme');
    if (t === 'light' || t === 'dark') return t;
    try {
      const o = JSON.parse(store.get('theme') || 'null');
      if (o && (o.value === 'light' || o.value === 'dark') && (!o.expiry || o.expiry > Date.now())) return o.value;
    } catch (e) { /* 壞掉的舊資料當沒選過 */ }
    return null;
  };

  // 沒手動選過才跟著系統切換
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light', false);
  });

  /* ---------- 繁簡切換 ---------- */

  // 兩種文字分開處理：
  // 1. 頁面原本就有的文字：轉成簡體時記下每個文字節點與屬性的原文，切回繁體直接還原，不做反向字典轉換
  //    （反向轉換會把「台」變「臺」、「后」變「後」）。還原前先確認內容還是我們轉的那一版，別的程式改過就不動。
  // 2. 之後由程式產生的文字（閱讀數、搜尋狀態、程式碼工具列、錯誤訊息）：一律經 setText／setAttr 寫入，
  //    這裡記住繁體原文，切換語言時用原文重畫。搜尋結果這種整塊重建的，用 onChange 讓元件自己重畫
  const translator = (() => {
    const btn = $('[data-action="translate"]');
    const SKIP = /^(SCRIPT|STYLE|PRE|CODE|TEXTAREA|SVG|NOSCRIPT)$/;
    const ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
    const texts = new Map();
    const attrs = new Map();
    const live = new Map(); // 元素 → { text: 原文, attrs: { 屬性: 原文 } }
    const listeners = [];
    let title = null;
    let toCn = null;
    let dict = null;
    let lang = 'tw';
    let queue = Promise.resolve();

    const conv = s => (lang === 'cn' && toCn ? toCn(s) : s);
    const remember = el => {
      if (!live.has(el)) live.set(el, { text: null, attrs: {} });
      return live.get(el);
    };
    const redrawLive = () => {
      live.forEach((rec, el) => {
        if (!el.isConnected) { live.delete(el); return; }
        if (rec.text !== null) el.textContent = conv(rec.text);
        Object.entries(rec.attrs).forEach(([a, s]) => el.setAttribute(a, conv(s)));
      });
    };

    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const orig = child.nodeValue;
          if (!orig.trim()) continue;
          const conv = toCn(orig);
          if (conv === orig) continue;
          texts.set(child, { orig, conv });
          child.nodeValue = conv;
        } else if (child.nodeType === 1 && !SKIP.test(child.tagName.toUpperCase())
          && !child.classList.contains('code-block') && !child.classList.contains('mermaid-diagram')) {
          for (const a of ATTRS) {
            const orig = child.getAttribute(a);
            if (!orig) continue;
            const conv = toCn(orig);
            if (conv === orig) continue;
            if (!attrs.has(child)) attrs.set(child, {});
            attrs.get(child)[a] = { orig, conv };
            child.setAttribute(a, conv);
          }
          walk(child);
        }
      }
    };

    const restore = () => {
      texts.forEach((r, node) => { if (node.nodeValue === r.conv) node.nodeValue = r.orig; });
      attrs.forEach((rec, el) => {
        Object.entries(rec).forEach(([a, r]) => { if (el.getAttribute(a) === r.conv) el.setAttribute(a, r.orig); });
      });
      if (title && document.title === title.conv) document.title = title.orig;
      texts.clear();
      attrs.clear();
      title = null;
    };

    const setLang = async target => {
      if (target === lang) return;
      if (target === 'cn') {
        if (!dict) dict = loadScript(KY.twcn).catch(e => { dict = null; throw e; });
        await dict;
        toCn = window.KyTwCn.toSimplified;
        walk(document.body);
        title = { orig: document.title, conv: toCn(document.title) };
        document.title = title.conv;
      } else {
        restore();
      }
      lang = target;
      store.set('ky-lang', target);
      document.documentElement.lang = target === 'cn' ? 'zh-CN' : 'zh-TW';
      if (btn) {
        btn.textContent = target === 'cn' ? '繁' : '簡';
        btn.setAttribute('aria-label', conv(target === 'cn' ? '切換成繁體中文' : '切換成簡體中文'));
      }
      redrawLive();
      listeners.forEach(fn => fn(lang));
    };
    // 字典還在載入時連按也不會兩次轉換：切換排隊執行，目標在輪到時才決定
    const enqueue = pick => {
      queue = queue.then(() => setLang(pick())).catch(e => toast(e.message));
      return queue;
    };

    return {
      // 只用在馬上要顯示、之後會整塊重建的字串（打字機、搜尋結果、toast）
      text: conv,
      isCn: () => lang === 'cn',
      setText(el, s) { remember(el).text = s; el.textContent = conv(s); },
      setAttr(el, a, s) { remember(el).attrs[a] = s; el.setAttribute(a, conv(s)); },
      // 拿掉屬性時連登記一起刪，切換語言才不會把它補回來
      unsetAttr(el, a) { const rec = live.get(el); if (rec) delete rec.attrs[a]; el.removeAttribute(a); },
      onChange(fn) { listeners.push(fn); },
      toggle() { enqueue(() => (lang === 'cn' ? 'tw' : 'cn')); },
      restore() { if (store.get('ky-lang') === 'cn') enqueue(() => 'cn'); }
    };
  })();
  const T = translator.text;
  const setText = translator.setText;
  const setAttr = translator.setAttr;
  labelAttr = setAttr;
  syncThemeButton(currentTheme());

  /* ---------- 搜尋 ---------- */

  const search = (() => {
    const dialog = $('#search');
    if (!dialog) return { open() {} };
    const input = $('input', dialog);
    const status = $('.search-status', dialog);
    const results = $('.search-results', dialog);
    let index = null;
    let loading = null;

    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const load = () => {
      if (!loading) {
        setText(status, '載入文章索引中…');
        loading = fetch(KY.search)
          .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(data => {
            index = data.map(d => ({ ...d, tw: { t: d.t, c: d.c, tl: d.t.toLowerCase(), cl: d.c.toLowerCase() }, cn: null }));
            setText(status, '');
          })
          .catch(e => {
            loading = null;
            setText(status, `索引載入失敗（${e.message}），關掉再開一次會重試。`);
          });
      }
      return loading;
    };

    // 比對、標亮、摘要都在同一種文字上做：簡體模式下把索引和查詢都轉成簡體再比，畫面上看到的詞就搜得到。
    // 簡體版第一次用到才轉，之後留著
    const view = d => {
      if (!translator.isCn()) return d.tw;
      if (!d.cn) { const t = T(d.t), c = T(d.c); d.cn = { t, c, tl: t.toLowerCase(), cl: c.toLowerCase() }; }
      return d.cn;
    };
    // 結果只連到本站的文章頁（/posts/:abbrlink/），連結直接用驗過的那個完整網址，不重新拼字串
    const POST_PATH = /^\/posts\/[A-Za-z0-9-]{1,80}\/$/;
    const safeHref = u => {
      try {
        const x = new URL(u, location.origin);
        return x.origin === location.origin && POST_PATH.test(x.pathname) ? x.href : '#';
      } catch (e) { return '#'; }
    };

    // 先切段再逐段 escape，關鍵字含 < 或 & 也不會切到 entity 中間
    const highlight = (text, terms) => {
      const re = new RegExp('(' + terms.map(escapeRe).join('|') + ')', 'gi');
      return text.split(re).map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join('');
    };
    const snippet = (v, terms) => {
      let at = -1;
      for (const t of terms) { const i = v.cl.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
      const start = Math.max(0, at - 30);
      return highlight((start > 0 ? '…' : '') + v.c.slice(start, start + 110) + '…', terms);
    };

    const run = () => {
      if (!index) return;
      const q = T(input.value.trim()).toLowerCase();
      results.innerHTML = '';
      if (!q) { setText(status, ''); return; }
      const terms = q.split(/\s+/).filter(Boolean);
      const hits = [];
      for (const d of index) {
        const v = view(d);
        if (!terms.every(t => v.tl.includes(t) || v.cl.includes(t))) continue;
        hits.push({ d, v, score: terms.filter(t => v.tl.includes(t)).length });
      }
      hits.sort((a, b) => b.score - a.score);
      setText(status, hits.length ? `找到 ${hits.length} 篇` : `沒有文章同時包含「${input.value.trim()}」。少打一個詞試試。`);
      results.innerHTML = hits.slice(0, 40).map(({ d, v }) =>
        `<li><a href="${escapeHtml(safeHref(d.u))}"><span class="r-title">${highlight(v.t, terms)}</span>` +
        `<span class="r-snippet">${escapeHtml(d.d)}　${snippet(v, terms)}</span></a></li>`
      ).join('');
    };
    translator.onChange(() => { if (dialog.open) run(); });

    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    $('[data-close]', dialog).addEventListener('click', () => dialog.close());
    // Enter 進第一筆結果。先用目前的輸入重算一次，不然打太快會進到上一個查詢的第一筆
    $('form', dialog).addEventListener('submit', e => {
      e.preventDefault();
      clearTimeout(timer);
      run();
      const first = $('a', results);
      if (first) location.href = first.href;
    });

    return {
      open() {
        if (!dialog.open) dialog.showModal();
        input.focus();
        input.select();
        load().then(run);
      }
    };
  })();

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      search.open();
    }
  });

  /* ---------- 按鈕 ---------- */

  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'search') search.open();
    else if (action === 'theme') applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    else if (action === 'translate') translator.toggle();
    else if (action === 'copy-link') toast(T(await copyText(el.dataset.url) ? '已複製連結' : '複製失敗，請手動複製網址列'));
    else if (action === 'native-share' && navigator.share) navigator.share({ title: el.dataset.title, url: el.dataset.url }).catch(() => {});
  });

  const nativeShare = $('[data-action="native-share"]');
  if (nativeShare && navigator.share) nativeShare.hidden = false;

  /* ---------- 首頁打字機 ---------- */

  const typed = $('.hero-sub[data-lines]');
  if (typed) {
    let lines = [];
    try { lines = JSON.parse(typed.dataset.lines); } catch (e) { /* 壞掉就維持靜態那句 */ }
    if (lines.length) {
      // 每天固定從不同句開始，不開動畫的人也看得到不同句
      let i = Math.floor(Date.now() / 864e5) % lines.length;
      // 動畫只記「第幾句、顯示到第幾個字」，每一格都用目前的語言從原句重算：
      // 切換繁簡後的下一格就是新語言，不會把舊語言的字寫回去（繁簡字典是一字對一字，字數不變）
      let shown = Array.from(lines[i]).length;
      const draw = () => { typed.textContent = Array.from(T(lines[i])).slice(0, shown).join(''); };
      draw();
      translator.onChange(draw);
      if (!reduceMotion && lines.length > 1) {
        typed.classList.add('is-typing');
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        (async () => {
          for (;;) {
            await sleep(3200);
            for (; shown > 0; shown--) { draw(); await sleep(28); }
            draw();
            i = (i + 1) % lines.length;
            const total = Array.from(lines[i]).length;
            while (shown < total) { shown++; draw(); await sleep(70); }
          }
        })();
      }
    }
  }

  /* ---------- 放大檢視（圖片、mermaid 圖表） ---------- */

  const zoom = (() => {
    const box = document.createElement('dialog');
    box.className = 'lightbox';
    box.setAttribute('aria-label', '放大檢視');
    box.innerHTML = '<button class="tool lightbox-close" type="button" aria-label="關閉放大檢視"><svg class="icon"><use href="#i-close"/></svg></button><div class="lightbox-body"></div>';
    document.body.appendChild(box);
    const body = $('.lightbox-body', box);
    let opener = null;
    box.addEventListener('click', () => box.close());
    box.addEventListener('close', () => {
      body.replaceChildren();
      if (opener && opener.isConnected) opener.focus();
      opener = null;
    });

    const open = el => {
      let node;
      if (el.tagName === 'IMG') {
        node = new Image();
        node.src = el.currentSrc || el.src;
        node.alt = el.alt;
      } else {
        const svg = $('svg', el);
        if (!svg) return;
        node = svg.cloneNode(true);
        node.removeAttribute('style');
      }
      body.replaceChildren(node);
      opener = el;
      box.showModal();
      $('.lightbox-close', box).focus();
    };

    // 讓元素能用鍵盤打開：Tab 停得到、Enter 或空白鍵開啟
    const enable = (el, label) => {
      el.dataset.zoom = '';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      setAttr(el, 'aria-label', label);
    };
    const disable = el => {
      delete el.dataset.zoom;
      el.removeAttribute('tabindex');
      el.removeAttribute('role');
      translator.unsetAttr(el, 'aria-label');
    };

    document.addEventListener('click', e => {
      const el = e.target.closest('[data-zoom]');
      if (el && !box.contains(el)) open(el);
    });
    document.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-zoom]')) {
        e.preventDefault();
        open(e.target);
      }
    });
    return { enable, disable };
  })();

  /* ---------- 文章頁 ---------- */

  const article = $('#article');

  if (article) {
    // 程式碼區塊：語言標籤、複製、超過設定高度先收起來
    const limit = KY.codeHeight || 400;
    const collapse = (wrap, fig) => {
      // 包在還沒展開的 <details> 裡量不到高度，等它第一次展開再量
      const closed = fig.closest('details:not([open])');
      if (closed) {
        closed.addEventListener('toggle', () => collapse(wrap, fig), { once: true });
        return;
      }
      if (fig.scrollHeight <= limit) return;
      wrap.classList.add('is-collapsed');
      wrap.style.setProperty('--code-max', limit + 'px');
      const lines = $$('td.code .line', fig).length;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'code-more';
      setText(more, lines ? `展開全部 ${lines} 行` : '展開全部');
      more.addEventListener('click', () => wrap.classList.remove('is-collapsed'));
      wrap.appendChild(more);
    };

    $$('figure.highlight', article).forEach(fig => {
      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      const lang = (fig.className.match(/highlight\s+([\w+#.-]+)/) || [])[1];
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      // 工具列在 .code-block 裡，整塊不參與頁面掃描轉換（程式碼不能被改字），文字改由 setText 管
      const langEl = document.createElement('span');
      langEl.className = 'code-lang';
      if (lang && lang !== 'plaintext') langEl.textContent = lang; else setText(langEl, '文字');
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-copy';
      setText(copyBtn, '複製');
      bar.append(langEl, copyBtn);
      fig.parentNode.insertBefore(wrap, fig);
      wrap.append(bar, fig);
      copyBtn.addEventListener('click', async () => {
        const code = $('td.code pre', fig) || $('pre', fig);
        const ok = await copyText(code.innerText.replace(/\n$/, ''));
        setText(copyBtn, ok ? '已複製' : '複製失敗');
        setTimeout(() => setText(copyBtn, '複製'), 1600);
      });
      collapse(wrap, fig);
    });

    // 標題旁的 # 連結，方便直接分享某一節
    $$('h2[id], h3[id], h4[id]', article).forEach(h => {
      const a = document.createElement('a');
      a.className = 'anchor';
      a.href = '#' + encodeURIComponent(h.id);
      a.setAttribute('aria-label', '這一節的連結');
      a.textContent = '#';
      h.appendChild(a);
    });

    // 內文圖片點了放大；本身是連結的圖照原本的連結走
    $$('img', article).forEach(img => {
      if (!img.closest('a')) zoom.enable(img, img.alt ? `放大圖片：${img.alt}` : '放大圖片');
    });
  }

  // 目錄：桌機常駐展開、手機預設收起；捲動時標出目前章節
  const tocBox = $('.toc-box');
  if (tocBox) {
    const wide = matchMedia('(min-width: 1100px)');
    const sync = () => { tocBox.open = wide.matches; };
    sync();
    wide.addEventListener('change', sync);
    tocBox.addEventListener('click', e => { if (e.target.closest('a') && !wide.matches) tocBox.open = false; });

    const links = $$('a.toc-link', tocBox);
    const byId = new Map();
    links.forEach(a => byId.set(decodeURIComponent(a.hash.slice(1)), a));
    const heads = Array.from(byId.keys()).map(id => document.getElementById(id)).filter(Boolean);
    if (heads.length && 'IntersectionObserver' in window) {
      const visible = new Set();
      const mark = () => {
        let active = heads.find(h => visible.has(h));
        if (!active) {
          // 兩個標題之間的長段落：取已經捲過去的最後一個
          active = heads.filter(h => h.getBoundingClientRect().top < 120).pop();
        }
        links.forEach(a => a.classList.remove('is-active'));
        if (active) byId.get(active.id).classList.add('is-active');
      };
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => { if (en.isIntersecting) visible.add(en.target); else visible.delete(en.target); });
        mark();
      }, { rootMargin: '-64px 0px -60% 0px' });
      heads.forEach(h => io.observe(h));
    }
  }

  /* ---------- mermaid ---------- */

  // KY.mermaid 只有在 build 時查得到 SRI hash 才會給；沒有就不載入，圖表維持原始碼顯示
  if (KY.mermaid) {
    const blocks = $$('pre > code.mermaid');
    if (blocks.length) {
      const nodes = blocks.map(code => {
        const div = document.createElement('div');
        div.className = 'mermaid-diagram';
        div.textContent = code.textContent;
        div.dataset.src = code.textContent;
        code.parentNode.replaceWith(div);
        return div;
      });
      const errText = e => (e && e.message ? e.message : String(e));
      const showError = msg => nodes.forEach(n => {
        zoom.disable(n);
        const note = document.createElement('p');
        note.className = 'comments-note';
        setText(note, `圖表沒畫出來（${msg}），以下是原始碼：`);
        const pre = document.createElement('pre');
        pre.textContent = n.dataset.src;
        n.replaceChildren(note, pre);
      });
      // 每次重畫都從原始碼重來，上一次失敗不影響下一次。initialize 同步丟出的錯誤也接得到
      const draw = theme => Promise.resolve()
        .then(() => {
          nodes.forEach(n => { n.removeAttribute('data-processed'); n.textContent = n.dataset.src; });
          window.mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default', securityLevel: 'strict' });
          return window.mermaid.run({ nodes });
        })
        .then(() => nodes.forEach(n => zoom.enable(n, '放大圖表')))
        .catch(e => showError(errText(e)));
      // 一次只畫一輪；排隊中的要求只有最後一個會畫（序號比對，連按「暗、亮、暗」也只畫最後那次）
      let seq = 0;
      let chain = Promise.resolve();
      const render = theme => {
        const mine = ++seq;
        chain = chain.then(() => (mine === seq ? draw(theme) : null)).catch(e => showError(errText(e)));
        return chain;
      };
      loadScript(KY.mermaid.src, { integrity: KY.mermaid.integrity, crossorigin: 'anonymous' })
        .then(() => {
          themeListeners.push(render);
          return render(currentTheme());
        })
        .catch(e => showError(e.message));
    }
  }

  /* ---------- Giscus 留言 ---------- */

  const slot = $('[data-giscus]');
  if (slot && KY.giscus) {
    const g = KY.giscus;
    const note = $('.comments-note', slot);
    const load = () => {
      const s = document.createElement('script');
      s.src = 'https://giscus.app/client.js';
      s.async = true;
      s.crossOrigin = 'anonymous';
      Object.entries(g).forEach(([k, v]) => { if (k.startsWith('data-')) s.setAttribute(k, v); });
      s.setAttribute('data-theme', currentTheme() === 'dark' ? g.dark : g.light);
      // 提示留到 client.js 載入成功才拿掉；載不到就改成說明原因
      s.onload = () => { if (note) note.remove(); };
      s.onerror = () => { if (note) setText(note, '留言區載入失敗：連不上 giscus.app。重新整理頁面再試一次。'); };
      slot.appendChild(s);
    };
    themeListeners.push(theme => {
      const frame = $('iframe.giscus-frame');
      if (frame) frame.contentWindow.postMessage({ giscus: { setConfig: { theme: theme === 'dark' ? g.dark : g.light } } }, 'https://giscus.app');
    });
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => {
        if (entries.some(en => en.isIntersecting)) { io.disconnect(); load(); }
      }, { rootMargin: '600px 0px' });
      io.observe(slot);
    } else {
      load();
    }
  }

  /* ---------- 閱讀數 ---------- */

  // 「一次閱讀」= 頁面在前景累計停留 minSeconds 秒；同一個瀏覽器、台北時間同一天、同一篇只算一次。
  // 載入就跑掉的機器流量不會被算進去。Worker 連不上時數字不顯示，頁面照常
  const views = KY.views;
  const viewsEl = $('[data-views]');
  if (views && views.path && viewsEl) {
    const api = views.endpoint.replace(/\/$/, '');
    let fromHit = false;
    const show = (n, isHit) => {
      if (!(n > 0)) return;
      if (!isHit && fromHit) return; // 晚到的讀取結果不要蓋掉剛加完的數字
      if (isHit) fromHit = true;
      setText(viewsEl, `${n.toLocaleString('zh-TW')} 次閱讀`);
      setAttr(viewsEl, 'title', `${views.since ? views.since + ' 起計算，' : ''}頁面在前景停留 ${views.minSeconds} 秒以上才算一次`);
      viewsEl.hidden = false;
    };
    fetch(`${api}/v?p=${encodeURIComponent(views.path)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => d && show(d.n, false))
      .catch(() => {});

    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const key = 'ky-v:' + views.path;
    // localStorage 紀錄值，日期都是台北時間：
    //   日期          已確認算到（Worker 回 200）
    //   pending:日期  送出中，或不確定 D1 有沒有寫進去（5xx、網路錯誤）
    //   skip:日期     Worker 判成爬蟲沒算（202）
    // 三種當天都不再送。寧可少算，不要多算
    const countedOn = d => {
      const v = store.get(key) || '';
      return v === d || v === 'pending:' + d || v === 'skip:' + d;
    };
    // 「查紀錄、寫 pending」和「把自己那筆 pending 改成結果」都要在同一把鎖裡做：
    // 同一篇開在不同分頁（可能是不同程序）時，localStorage 本身沒有 compare-and-set。
    // 不支援 Web Locks 的瀏覽器沒辦法保證只送一次，乾脆不送（這些瀏覽器的閱讀不計）
    const hasLocks = !!(navigator.locks && navigator.locks.request);
    const locked = fn => navigator.locks.request(key, fn);
    // 取得這次送出的資格，回傳日期；拿不到（沒有鎖、當天已送過、寫不進 localStorage）回 null。
    // 日期只取一次，比對和寫入用同一個值，不會剛好跨過午夜而兩邊不一致
    const claim = () => (hasLocks ? locked(() => {
      const d = today();
      if (countedOn(d)) return null;
      return store.set(key, 'pending:' + d) ? d : null;
    }) : Promise.resolve(null));
    // 只改自己送出時寫的那筆。紀錄已經不是它（隔天的閱讀、別的分頁改過）就不動，晚到的舊回應不會蓋掉新紀錄
    const settle = (d, next) => locked(() => {
      if (store.get(key) !== 'pending:' + d) return;
      if (next) store.set(key, next); else store.remove(key);
    });
    const send = d => fetch(`${api}/hit`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: views.path, keepalive: true })
      .then(r => {
        if (r.status === 200) {
          // 先把「已算到」記好，再處理要顯示的數字；回應內容壞掉不影響紀錄
          return settle(d, d).then(() => r.json().then(x => show(x.n, true), () => {}));
        }
        if (r.status === 202) return settle(d, 'skip:' + d);
        // 4xx 是 Worker 在碰 D1 之前就拒絕（格式、Origin、長度），確定沒算到：清掉紀錄，下次讀可以再送
        if (r.status >= 400 && r.status < 500) return settle(d, null);
        // 5xx 不知道 D1 有沒有寫進去，保留 pending
        return null;
      });

    if (hasLocks && !countedOn(today())) {
      // 停留時間用 performance.now()（單調時鐘），使用者或系統校時不會讓秒數暴增或倒退。
      // since 是目前這段前景的起點；不在前景時是 null
      const visible = () => document.visibilityState === 'visible';
      let seen = 0;
      let since = visible() ? performance.now() : null;
      let done = false;
      const tick = () => {
        if (done) return;
        const now = performance.now();
        if (since !== null) seen += now - since;
        since = visible() ? now : null;
        if (seen < views.minSeconds * 1000) return;
        done = true;
        // 讀滿了才搶資格：同一篇開在別的分頁、先讀滿的那頁已經送過，這裡就拿不到。
        // 網路錯誤時不知道 D1 有沒有寫進去，保留 pending 不重送
        claim().then(d => (d ? send(d) : null)).catch(() => {});
      };
      // 切到背景時先結算這段前景；切回前景時 tick 會把起點設成現在
      document.addEventListener('visibilitychange', tick);
      const timer = setInterval(() => { tick(); if (done) clearInterval(timer); }, 2000);
    }
  }

  translator.restore();
})();
