/* Disha Learning (ClassX) native integration for the Codexyt portal.
   - API layer (direct base + Koyeb proxy fallback + configurable Bearer token)
   - Batch viewer: Lectures | Live | Notes | About
   - Built-in HLS player (hls.js) with speed / quality / PiP / fullscreen
   - API settings modal (token, proxy, base URL)                              */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- config */
  var LS = { base: "disha_api_base", proxy: "disha_proxy", token: "disha_token", cache: "disha_batches_cache" };
  var DEFAULTS = {
    base: "https://dishaonlineclassesapi.classx.co.in",
    proxy: "/api/koyeb",
    fallback: "https://open-mora-natking151-ea9216fb.koyeb.app"
  };

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  var remoteBase = "";
  function cfg() {
    return {
      base: (lsGet(LS.base) || remoteBase || DEFAULTS.base).replace(/\/+$/, ""),
      proxy: (lsGet(LS.proxy) || DEFAULTS.proxy).replace(/\/+$/, ""),
      token: lsGet(LS.token).trim()
    };
  }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }
  function toast(msg) { if (typeof window.showToast === "function") window.showToast(msg); }

  /* ------------------------------------------------------------- API layer */
  function authHeaders() {
    var t = cfg().token, h = { Accept: "*/*" };
    if (t) h.Authorization = /^Bearer\s/i.test(t) ? t : "Bearer " + t;
    return h;
  }
  function fetchJson(url, ms) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 15000) : null;
    return fetch(url, { headers: authHeaders(), signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        return r.text().then(function (txt) {
          var data = null;
          try { data = JSON.parse(txt); } catch (e) {}
          if (!r.ok && !data) throw new Error("HTTP " + r.status);
          if (!data) throw new Error("Server did not return JSON");
          return data;
        });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }
  /* path like "/appx/batches/57?parent_id=1" - apiBase is appended automatically */
  function api(path) {
    var c = cfg();
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    var full = path + sep + "apiBase=" + encodeURIComponent(c.base);
    var first = c.proxy + full;
    var second = DEFAULTS.fallback + full;
    return fetchJson(first).catch(function () {
      if (c.proxy === DEFAULTS.fallback) throw new Error("API unreachable");
      return fetchJson(second);
    });
  }
  function apiErrorMessage(data) {
    if (!data) return "";
    if (data.success === false || data.error) return String(data.message || data.error || "Server returned an error");
    return "";
  }
  function getContent(batchId, parentId) {
    return api("/appx/batches/" + encodeURIComponent(batchId) + (parentId ? "?parent_id=" + encodeURIComponent(parentId) : ""));
  }
  function getVideo(videoId, courseId) {
    return api("/appx/videos/" + encodeURIComponent(videoId) + "?course_id=" + encodeURIComponent(courseId) + "&refresh=true");
  }
  function getLive(batchId) {
    return api("/appx/batches/" + encodeURIComponent(batchId) + "/live");
  }
  function getBatchList() { return api("/appx/batches"); }

  /* ---------------------------------------------------- batch normalisation */
  function normalizeBatch(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = raw._id || raw.id || raw.course_id || raw.batch_id;
    if (id == null || id === "") return null;
    if (/^(FOLDER|VIDEO|PDF)$/i.test(String(raw.type || ""))) return null;
    var name = raw.name || raw.batch_name || raw.course_name || raw.title || "Disha Batch";
    var subjects = raw.subjects || raw.subBatches || [];
    if (!Array.isArray(subjects)) subjects = [];
    var subs = subjects.map(function (s) {
      return typeof s === "string" ? { name: s } : { name: s.name || s.title || s.subject_name || "", byName: s.byName || "" };
    }).filter(function (s) { return s.name; });
    return {
      _id: String(id),
      batch_id: String(id),
      name: name,
      byName: raw.byName || raw.description || raw.tagline || "Disha Learning",
      startDate: raw.startDate || raw.start_date || "",
      endDate: raw.endDate || raw.end_date || raw.expiry_date || "",
      language: raw.language || "Hinglish",
      previewImage: raw.previewImage || raw.thumbnail || raw.image || raw.banner || raw.course_thumbnail || "",
      price: raw.price != null ? raw.price : (raw.feeTotal != null ? raw.feeTotal : ""),
      type: raw.type || "DISHA",
      slug: raw.slug || String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: raw.description || "",
      defaultTab: raw.defaultTab || "",
      fallback: !!raw.fallback,
      subBatches: subs
    };
  }
  function normalizeList(data) {
    var arr = Array.isArray(data) ? data : (data && (data.batches || data.courses || data.data || data.content)) || [];
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeBatch).filter(Boolean);
  }
  function loadLocal() {
    return fetch("batches.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("batches.json unavailable"); return r.json(); })
      .then(function (d) { var list = normalizeList(d); lsSet(LS.cache, JSON.stringify(list)); return list; })
      .catch(function () {
        try { var c = JSON.parse(lsGet(LS.cache) || "[]"); return Array.isArray(c) ? c : []; } catch (e) { return []; }
      });
  }
  /* Live batch list. Disha serves it from /courses.json (same data its own site shows).
     Tried in order: our own rewrite (/api/disha-courses, no CORS issue), the Disha site directly,
     then the ClassX proxy. Any failure falls through silently to the next source. */
  var COURSE_SOURCES = ["/api/disha-courses", "https://disha-studyapkmod.vercel.app/courses.json"];
  function fetchPublic(url) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 12000) : null;
    return fetch(url, { cache: "no-cache", signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { if (timer) clearTimeout(timer); });
  }
  function loadRemote() {
    function from(i) {
      if (i >= COURSE_SOURCES.length) {
        return getBatchList().then(function (d) { return apiErrorMessage(d) ? [] : normalizeList(d); }).catch(function () { return []; });
      }
      return fetchPublic(COURSE_SOURCES[i]).then(function (d) {
        if (d && typeof d.apiBase === "string" && /^https?:\/\//.test(d.apiBase)) remoteBase = d.apiBase.trim();
        var list = normalizeList(d);
        return list.length ? list : from(i + 1);
      }).catch(function () { return from(i + 1); });
    }
    return from(0).then(function (list) { if (list.length) lsSet(LS.cache, JSON.stringify(list)); return list; });
  }
  function mergeBatches(local, remote) {
    var real = remote.filter(function (b) { return !b.fallback; });
    var base = real.length ? local.filter(function (b) { return !b.fallback; }) : local;
    var map = {}, out = [];
    real.concat(base).forEach(function (b) { if (!map[b._id]) { map[b._id] = b; out.push(b); } });
    return out;
  }

  /* -------------------------------------------------------------- view state */
  var S = { batch: null, tab: "lectures", path: [], items: null, loading: false, error: "", search: "", live: null };
  var viewEl = null, playerEl = null, settingsEl = null, hls = null, pdfEl = null;

  function pushLayer() {
    try { history.pushState({ disha: 1, depth: viewEl && !viewEl.hidden ? S.path.length : 0 }, ""); } catch (e) {}
  }
  function goBack() { history.back(); }

  /* ---------------------------------------------------------------- viewer */
  function ensureView() {
    if (viewEl) return viewEl;
    viewEl = document.createElement("div");
    viewEl.id = "dishaView";
    viewEl.className = "dv";
    viewEl.hidden = true;
    document.body.appendChild(viewEl);
    viewEl.addEventListener("click", onViewClick);
    viewEl.addEventListener("input", function (e) {
      if (e.target && e.target.id === "dvSearch") {
        S.search = e.target.value;
        renderList();
      }
    });
    return viewEl;
  }
  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d)) return String(v);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function openBatchView(batch) {
    S = { batch: batch, tab: /^(lectures|live|notes|about)$/.test(batch.defaultTab || "") ? batch.defaultTab : "lectures", path: [{ id: "", name: "All subjects" }], items: null, loading: false, error: "", search: "", live: null };
    ensureView();
    viewEl.hidden = false;
    document.documentElement.classList.add("dv-lock");
    pushLayer();
    renderShell();
    loadFolder();
  }
  function closeBatchView() {
    if (!viewEl) return;
    viewEl.hidden = true;
    document.documentElement.classList.remove("dv-lock");
  }

  function renderShell() {
    var b = S.batch;
    var tabs = [["lectures", "Lectures"], ["live", "Live"], ["notes", "Notes"], ["about", "About"]];
    viewEl.innerHTML =
      '<div class="dv-head">' +
        '<button class="dv-iconbtn" data-act="back" aria-label="Back">' + ico("back") + "</button>" +
        '<div class="dv-headtitle">' + esc(b.name) + "</div>" +
        '<button class="dv-iconbtn" data-act="settings" aria-label="API settings">' + ico("gear") + "</button>" +
      "</div>" +
      '<div class="dv-body">' +
        '<div class="dv-card">' +
          '<img class="dv-cover" src="' + esc(b.previewImage || "assets/codex-telegram.png") + '" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=\'assets/codex-telegram.png\'">' +
          '<div class="dv-cardinfo"><h2>' + esc(b.name) + "</h2>" +
          '<div class="dv-chips"><span class="dv-chip">Recorded</span><span class="dv-chip">Live</span>' +
          (b.language ? '<span class="dv-chip">' + esc(b.language) + "</span>" : "") +
          (b.startDate ? '<span class="dv-chip">' + esc(fmtDate(b.startDate)) + "</span>" : "") + "</div></div>" +
        "</div>" +
        '<div class="dv-tabs" role="tablist">' +
          tabs.map(function (t) {
            return '<button role="tab" class="dv-tab' + (S.tab === t[0] ? " active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>";
          }).join("") +
        "</div>" +
        '<div id="dvPane"></div>' +
      "</div>";
    renderPane();
  }

  function renderPane() {
    var pane = viewEl.querySelector("#dvPane");
    if (!pane) return;
    if (S.tab === "about") { pane.innerHTML = aboutHtml(); return; }
    if (S.tab === "live") { renderLive(pane); return; }
    pane.innerHTML =
      '<div class="dv-crumbs" id="dvCrumbs"></div>' +
      '<div class="dv-searchrow"><input id="dvSearch" type="search" placeholder="Search in this folder..." value="' + esc(S.search) + '"><button class="dv-iconbtn" data-act="refresh" aria-label="Refresh">' + ico("refresh") + "</button></div>" +
      '<div id="dvList" class="dv-list"></div>';
    renderList();
  }

  function aboutHtml() {
    var b = S.batch;
    var rows = [
      ["Batch", b.name], ["Language", b.language], ["Starts", fmtDate(b.startDate) || "—"],
      ["Ends", fmtDate(b.endDate) || "—"], ["Batch ID", b._id]
    ];
    var subj = (b.subBatches || []).map(function (s) { return '<span class="dv-chip">' + esc(s.name) + "</span>"; }).join("");
    return '<div class="dv-about">' +
      (b.description ? "<p>" + esc(b.description) + "</p>" : "") +
      rows.map(function (r) { return '<div class="dv-fact"><span>' + esc(r[0]) + "</span><span>" + esc(r[1]) + "</span></div>"; }).join("") +
      (subj ? '<h3>Subjects</h3><div class="dv-chips">' + subj + "</div>" : "") +
      "</div>";
  }

  /* ------------------------------------------------------- folder browsing */
  function loadFolder() {
    var cur = S.path[S.path.length - 1];
    S.loading = true; S.error = ""; S.items = null;
    renderList();
    var token = cur.id + "|" + S.path.length;
    getContent(S.batch._id, cur.id).then(function (data) {
      if (token !== (S.path[S.path.length - 1].id + "|" + S.path.length)) return;
      var err = apiErrorMessage(data);
      var list = data && (data.content || data.data || data.items);
      if (err && !Array.isArray(list)) throw new Error(err);
      S.items = Array.isArray(list) ? list : [];
      S.loading = false;
      renderList();
    }).catch(function (e) {
      S.loading = false; S.error = (e && e.message) || "Failed to load content";
      renderList();
    });
  }

  function itemType(it) {
    var t = String(it.type || "").toUpperCase();
    if (t === "FOLDER" || t === "VIDEO" || t === "PDF") return t;
    if (it.pdf_link || it.pdf_link2 || it.study_material_link) return "PDF";
    return it.files_count != null ? "FOLDER" : "VIDEO";
  }
  function itemTitle(it) { return it.title || it.Title || it.name || "Untitled"; }

  function renderList() {
    var crumbs = viewEl && viewEl.querySelector("#dvCrumbs");
    if (crumbs) {
      crumbs.innerHTML = S.path.map(function (p, i) {
        var last = i === S.path.length - 1;
        return '<button class="dv-crumb' + (last ? " active" : "") + '" data-crumb="' + i + '">' + esc(p.name) + "</button>";
      }).join('<span class="dv-sep">›</span>');
    }
    var box = viewEl && viewEl.querySelector("#dvList");
    if (!box) return;
    if (S.loading) { box.innerHTML = '<div class="dv-skel"></div><div class="dv-skel"></div><div class="dv-skel"></div>'; return; }
    if (S.error) {
      var hint = /401|403|auth|token|login/i.test(S.error) ? " Your API token may be missing or expired." : "";
      box.innerHTML = '<div class="dv-empty"><b>Could not load content</b><p>' + esc(S.error) + "." + hint + '</p>' +
        '<div class="dv-row"><button class="dv-btn" data-act="refresh">Retry</button><button class="dv-btn ghost" data-act="settings">API settings</button></div></div>';
      return;
    }
    var q = S.search.trim().toLowerCase();
    var items = (S.items || []).filter(function (it) {
      var t = itemType(it);
      if (S.tab === "notes" && t === "VIDEO" && !it.has_pdf) return false;
      if (S.tab === "lectures" && t === "PDF") return false;
      return !q || itemTitle(it).toLowerCase().indexOf(q) !== -1;
    });
    if (!items.length) {
      box.innerHTML = '<div class="dv-empty"><b>' + (q ? "No matches" : "Nothing here") + "</b><p>" +
        (S.tab === "notes" ? "No notes in this folder." : "No lectures or folders in this folder.") + "</p></div>";
      return;
    }
    box.innerHTML = items.map(function (it) {
      var t = itemType(it), title = esc(itemTitle(it)), id = esc(it.id);
      if (t === "FOLDER") {
        return '<div class="dv-row-item" data-folder="' + id + '" data-name="' + title + '"><div class="dv-ic">' + ico("folder") + '</div><div class="dv-meta"><h4>' + title + "</h4><span>" +
          (it.files_count != null ? esc(it.files_count) + " items" : "Folder") + (it.date ? " · " + esc(String(it.date).split(" ")[0]) : "") + '</span></div><div class="dv-go">›</div></div>';
      }
      if (t === "PDF") {
        var link = it.pdf_link || it.pdf_link2 || it.study_material_link || "";
        return '<div class="dv-row-item" data-pdf="' + esc(link) + '" data-name="' + title + '"><div class="dv-ic pdf">' + ico("pdf") + '</div><div class="dv-meta"><h4>' + title + "</h4><span>Study material</span></div><div class=\"dv-go\">" + ico("open") + "</div></div>";
      }
      return '<div class="dv-row-item" data-video="' + id + '" data-name="' + title + '"><div class="dv-ic vid">' +
        (it.thumbnail ? '<img src="' + esc(it.thumbnail) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : ico("play")) +
        '</div><div class="dv-meta"><h4>' + title + "</h4><span>" + (it.duration ? esc(it.duration) : "Lecture") + (it.has_pdf ? " · Notes PDF" : "") + '</span></div><div class="dv-go">' + ico("play") + "</div></div>";
    }).join("");
  }

  /* --------------------------------------------------------------- live tab */
  function renderLive(pane) {
    if (S.live && S.live.data) { pane.innerHTML = liveHtml(S.live.data); return; }
    pane.innerHTML = '<div class="dv-skel"></div><div class="dv-skel"></div>';
    if (S.live && S.live.pending) return;
    S.live = { pending: true };
    getLive(S.batch._id).then(function (d) {
      var err = apiErrorMessage(d);
      if (err && !d.live && !d.upcoming) throw new Error(err);
      var ended = Array.isArray(d.ended) && d.ended.length ? d.ended : (Array.isArray(d.previous) ? d.previous : []);
      S.live = { data: { live: d.live || [], upcoming: d.upcoming || [], ended: ended } };
    }).catch(function (e) {
      S.live = { data: { error: (e && e.message) || "Failed to load live sessions" } };
    }).then(function () { if (S.tab === "live") renderPane(); });
  }
  function liveUrl(it) { return it.video_url || it.stream_url || it.hls_url || it.url || ""; }
  function liveHtml(d) {
    if (d.error) return '<div class="dv-empty"><b>Live sessions unavailable</b><p>' + esc(d.error) + '</p><div class="dv-row"><button class="dv-btn" data-act="reload-live">Retry</button><button class="dv-btn ghost" data-act="settings">API settings</button><button class="dv-btn ghost" data-act="demo-live">Test player</button></div></div>';
    var groups = [["live", "Live now", d.live], ["upcoming", "Upcoming", d.upcoming], ["ended", "Recordings", d.ended]];
    var any = groups.some(function (g) { return g[2].length; });
    if (!any) return '<div class="dv-empty"><b>No sessions</b><p>No live or upcoming sessions for this batch.</p></div>';
    window.__dishaLive = {};
    return groups.map(function (g) {
      if (!g[2].length) return "";
      return "<h3 class=\"dv-h3\">" + g[1] + "</h3><div class=\"dv-list\">" + g[2].map(function (it, i) {
        var key = g[0] + i; window.__dishaLive[key] = it;
        var title = it.title || it.Title || it.name || "Session";
        var when = it.event_date || it.date_and_time || it.created_at || "";
        var playable = !!liveUrl(it) && g[0] !== "upcoming";
        return '<div class="dv-row-item' + (playable ? "" : " dim") + '" ' + (playable ? 'data-live="' + key + '"' : "") + '><div class="dv-ic vid">' + (g[0] === "live" ? '<span class="dv-dot"></span>' : ico("play")) + '</div><div class="dv-meta"><h4>' + esc(title) + "</h4><span>" + esc(when) + (g[0] === "upcoming" ? " · Starts soon" : "") + '</span></div><div class="dv-go">' + (playable ? ico("play") : "") + "</div></div>";
      }).join("") + "</div>";
    }).join("");
  }

  /* ----------------------------------------------------------- click router */
  function onViewClick(e) {
    var t = e.target.closest("[data-act],[data-tab],[data-crumb],[data-folder],[data-video],[data-pdf],[data-live]");
    if (!t || !viewEl.contains(t)) return;
    if (t.dataset.act === "back") return goBack();
    if (t.dataset.act === "settings") return openSettings();
    if (t.dataset.act === "refresh") return loadFolder();
    if (t.dataset.act === "reload-live") { S.live = null; return renderPane(); }
    if (t.dataset.act === "demo-live") return openPlayer({ title: "Player test stream (sample video, not a class)", sources: [{ label: "Auto", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" }], pdfs: [] });
    if (t.dataset.tab) {
      S.tab = t.dataset.tab; S.search = "";
      viewEl.querySelectorAll(".dv-tab").forEach(function (b) { b.classList.toggle("active", b === t); });
      return renderPane();
    }
    if (t.dataset.crumb != null) {
      var idx = Number(t.dataset.crumb), steps = S.path.length - 1 - idx;
      if (steps > 0) history.go(-steps);
      return;
    }
    if (t.dataset.folder) {
      S.path.push({ id: t.dataset.folder, name: t.dataset.name });
      S.search = ""; pushLayer(); renderPane(); loadFolder(); return;
    }
    if (t.dataset.pdf != null) return openPdf(t.dataset.pdf, t.dataset.name);
    if (t.dataset.video) return playLecture(t.dataset.video, t.dataset.name, t);
    if (t.dataset.live) {
      var it = window.__dishaLive && window.__dishaLive[t.dataset.live];
      if (it) openPlayer({ title: it.title || it.Title || it.name || "Live session", sources: [{ label: "Auto", url: liveUrl(it) }], live: /live/.test(t.dataset.live), pdfs: [] });
    }
  }

  /* ---------------------------------------------------------------- lecture */
  function toArr(v) { return Array.isArray(v) ? v : []; }
  function pdfList(v) {
    return toArr(v).map(function (p, i) {
      if (typeof p === "string") return { name: "Notes " + (i + 1), url: p };
      var url = p.url || p.link || p.pdf_link || p.file_link || p.href || "";
      return url ? { name: p.name || p.title || "Notes " + (i + 1), url: url } : null;
    }).filter(Boolean);
  }
  function playLecture(videoId, title, row) {
    if (row) row.classList.add("busy");
    getVideo(videoId, S.batch._id).then(function (d) {
      var err = apiErrorMessage(d);
      var v = d && d.video;
      if ((err && !v) || !v) throw new Error(err || "Unable to fetch the video link");
      var quals = toArr(v.hlsQualities).map(function (q, i) {
        return { label: q.quality || q.label || q.name || ("Source " + (i + 1)), url: q.url || q.link || "" };
      }).filter(function (q) { return q.url; });
      var isAppx = !!(v.isAppxPlayer || (v.playUrl && /combined-img-player/.test(v.playUrl)));
      var isYt = !!(v.isYouTube || /youtu\.be|youtube\.com/.test(String(v.playUrl || "")));
      var opts = { title: v.title || title, pdfs: pdfList(v.pdfLinks), sources: quals };
      if (isYt && v.playUrl) opts.embed = ytEmbed(v.playUrl);
      else if (isAppx && v.playUrl) opts.embed = String(v.playUrl).replace(/^https:\/\/appx-play\.classx\.co\.in/, "/api/appx-play");
      else if (!quals.length && v.playUrl) {
        if (/\.m3u8(\?|$)/i.test(v.playUrl)) opts.sources = [{ label: "Auto", url: v.playUrl }];
        else opts.embed = v.playUrl;
      }
      if (!opts.sources.length && !opts.embed) throw new Error("No playable stream returned for this lecture");
      openPlayer(opts);
    }).catch(function (e) {
      toast((e && e.message) || "Failed to open lecture");
    }).then(function () { if (row) row.classList.remove("busy"); });
  }
  function ytEmbed(u) {
    var m = String(u).match(/(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{6,})/);
    return m ? "https://www.youtube.com/embed/" + m[1] : u;
  }

  /* ----------------------------------------------------------------- player */
  var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  function openPlayer(o) {
    destroyPlayer();
    playerEl = document.createElement("div");
    playerEl.className = "dp";
    playerEl.id = "dishaPlayer";
    var pdfs = (o.pdfs || []).map(function (p) {
      return '<button class="dv-btn ghost" data-pdf-open="' + esc(p.url) + '" data-name="' + esc(p.name) + '">' + ico("pdf") + " " + esc(p.name) + "</button>";
    }).join("");
    playerEl.innerHTML =
      '<div class="dv-head"><button class="dv-iconbtn" data-p="back" aria-label="Close player">' + ico("back") + '</button><div class="dv-headtitle">' + esc(o.title) + "</div>" +
      (o.live ? '<span class="dv-livebadge">LIVE</span>' : "") + "</div>" +
      '<div class="dp-stage" id="dpStage">' +
        (o.embed
          ? '<iframe class="dp-embed" src="' + esc(o.embed) + '" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>'
          : '<video id="dpVideo" playsinline webkit-playsinline></video>' +
            '<div class="dp-spin" id="dpSpin"></div>' +
            '<div class="dp-ctl" id="dpCtl">' +
              '<input type="range" id="dpSeek" min="0" max="1000" value="0" step="1" aria-label="Seek">' +
              '<div class="dp-bar">' +
                '<button data-p="play" aria-label="Play or pause">' + ico("play") + "</button>" +
                '<button data-p="rew" aria-label="Back 10 seconds">' + ico("rew") + "</button>" +
                '<button data-p="fwd" aria-label="Forward 10 seconds">' + ico("fwd") + "</button>" +
                '<span class="dp-time" id="dpTime">0:00 / 0:00</span><span class="dp-grow"></span>' +
                '<select id="dpSpeed" aria-label="Speed">' + SPEEDS.map(function (s) { return '<option value="' + s + '"' + (s === 1 ? " selected" : "") + ">" + s + "x</option>"; }).join("") + "</select>" +
                '<select id="dpQual" aria-label="Quality"></select>' +
                '<button data-p="pip" aria-label="Picture in picture">' + ico("pip") + "</button>" +
                '<button data-p="fs" aria-label="Fullscreen">' + ico("fs") + "</button>" +
              "</div></div>") +
      "</div>" +
      (pdfs ? '<div class="dp-notes"><b>Notes</b><div class="dv-row">' + pdfs + "</div></div>" : "") +
      (o.embed ? '<div class="dp-note">Playing in the embedded ClassX player.</div>' : "");
    document.body.appendChild(playerEl);
    pushLayer();
    playerEl.addEventListener("click", onPlayerClick);
    if (!o.embed) initVideo(o);
  }

  function destroyPlayer() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (playerEl) { var v = playerEl.querySelector("video"); if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} } playerEl.remove(); playerEl = null; }
    document.removeEventListener("keydown", onKey);
  }
  function isPlayerOpen() { return !!playerEl; }

  function fmtT(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    s = Math.floor(s); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
  }

  function initVideo(o) {
    var video = playerEl.querySelector("#dpVideo"), seek = playerEl.querySelector("#dpSeek"),
        timeEl = playerEl.querySelector("#dpTime"), spin = playerEl.querySelector("#dpSpin"),
        speedSel = playerEl.querySelector("#dpSpeed"), qualSel = playerEl.querySelector("#dpQual");
    var sources = o.sources.slice();
    var srcIdx = 0, seeking = false;
    var multi = sources.length > 1;

    function attach(url, resumeAt) {
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      var isHls = /\.m3u8(\?|$)/i.test(url) || /m3u8/i.test(url);
      if (isHls && window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({ enableWorker: true, lowLatencyMode: !!o.live, maxBufferLength: 40 });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          if (!multi) buildHlsQualities();
          if (resumeAt) video.currentTime = resumeAt;
          video.playbackRate = Number(speedSel.value) || 1;
          video.play().catch(function () {});
        });
        hls.on(window.Hls.Events.ERROR, function (_, d) {
          if (!d.fatal) return;
          if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) { toast("Network error - retrying stream"); try { hls.startLoad(); } catch (e) {} }
          else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); } catch (e) {} }
          else toast("Stream failed to load. The link may have expired - go back and reopen the lecture.");
        });
      } else {
        video.src = url;
        video.addEventListener("loadedmetadata", function once() {
          video.removeEventListener("loadedmetadata", once);
          if (resumeAt) video.currentTime = resumeAt;
          video.playbackRate = Number(speedSel.value) || 1;
          video.play().catch(function () {});
        });
      }
    }
    function buildHlsQualities() {
      if (!hls) return;
      var levels = hls.levels || [];
      qualSel.innerHTML = '<option value="-1">Auto</option>' + levels.map(function (l, i) {
        return '<option value="' + i + '">' + (l.height ? l.height + "p" : Math.round((l.bitrate || 0) / 1000) + "k") + "</option>";
      }).join("");
      qualSel.style.display = levels.length > 1 ? "" : "none";
    }
    if (multi) {
      qualSel.innerHTML = sources.map(function (s, i) { return '<option value="' + i + '">' + esc(s.label) + "</option>"; }).join("");
    } else { qualSel.style.display = "none"; }

    qualSel.addEventListener("change", function () {
      var v = Number(qualSel.value);
      if (multi) { var t = video.currentTime; srcIdx = v; attach(sources[srcIdx].url, t); }
      else if (hls) { hls.currentLevel = v; }
    });
    speedSel.addEventListener("change", function () { video.playbackRate = Number(speedSel.value) || 1; });
    video.addEventListener("timeupdate", function () {
      if (!seeking && video.duration && isFinite(video.duration)) seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
      timeEl.textContent = fmtT(video.currentTime) + " / " + fmtT(video.duration);
    });
    seek.addEventListener("input", function () { seeking = true; });
    seek.addEventListener("change", function () {
      if (video.duration && isFinite(video.duration)) video.currentTime = (Number(seek.value) / 1000) * video.duration;
      seeking = false;
    });
    video.addEventListener("waiting", function () { spin.style.display = "block"; });
    ["playing", "canplay", "pause"].forEach(function (ev) { video.addEventListener(ev, function () { spin.style.display = "none"; }); });
    video.addEventListener("click", function () { togglePlay(video); });
    document.addEventListener("keydown", onKey);
    attach(sources[0].url, 0);
  }

  function togglePlay(video) { if (video.paused) video.play().catch(function () {}); else video.pause(); }
  function onKey(e) {
    var v = playerEl && playerEl.querySelector("video");
    if (!v || /INPUT|SELECT|TEXTAREA/.test((e.target.tagName || ""))) return;
    if (e.key === " ") { e.preventDefault(); togglePlay(v); }
    else if (e.key === "ArrowRight") v.currentTime += 10;
    else if (e.key === "ArrowLeft") v.currentTime -= 10;
    else if (e.key === "f" || e.key === "F") toggleFs();
  }
  function toggleFs() {
    var st = playerEl && playerEl.querySelector("#dpStage");
    if (!st) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (st.requestFullscreen) st.requestFullscreen().catch(function () {});
    else { var v = st.querySelector("video"); if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); }
  }
  function onPlayerClick(e) {
    var po = e.target.closest("[data-pdf-open]");
    if (po) return openPdf(po.dataset.pdfOpen, po.dataset.name);
    var b = e.target.closest("[data-p]");
    if (!b) return;
    var video = playerEl.querySelector("video");
    var a = b.dataset.p;
    if (a === "back") return goBack();
    if (!video) return;
    if (a === "play") togglePlay(video);
    else if (a === "rew") video.currentTime = Math.max(0, video.currentTime - 10);
    else if (a === "fwd") video.currentTime = video.currentTime + 10;
    else if (a === "fs") toggleFs();
    else if (a === "pip") {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(function () { toast("Picture-in-picture is not available"); });
      else toast("Picture-in-picture is not supported in this browser");
    }
  }

  /* -------------------------------------------------------------------- PDF */
  function openPdf(url, name) {
    if (!url) return toast("No document link for this item");
    closePdfEl();
    pdfEl = document.createElement("div");
    pdfEl.className = "dp dpdf";
    pdfEl.innerHTML = '<div class="dv-head"><button class="dv-iconbtn" data-x="back" aria-label="Close">' + ico("back") + '</button><div class="dv-headtitle">' + esc(name || "Document") + '</div>' +
      '<a class="dv-btn ghost" href="' + esc(url) + '" target="_blank" rel="noopener">Open</a></div>' +
      '<iframe class="dp-embed" src="' + esc(url) + '"></iframe>' +
      '<div class="dp-note">If the document does not display here, use Open to view or download it.</div>';
    document.body.appendChild(pdfEl);
    pushLayer();
    pdfEl.addEventListener("click", function (e) { if (e.target.closest("[data-x=back]")) goBack(); });
  }
  function closePdfEl() { if (pdfEl) { pdfEl.remove(); pdfEl = null; } }

  /* --------------------------------------------------------------- settings */
  function openSettings() {
    closeSettingsEl();
    var c = cfg();
    settingsEl = document.createElement("div");
    settingsEl.className = "dv-overlay";
    settingsEl.innerHTML =
      '<div class="dv-modal" role="dialog" aria-modal="true" aria-label="API settings">' +
        '<button class="dv-iconbtn dv-x" data-s="close" aria-label="Close">×</button>' +
        "<h2>API Settings</h2>" +
        "<label>Authorization token (Bearer)</label>" +
        '<input id="dsToken" type="password" autocomplete="off" placeholder="Paste your token" value="' + esc(c.token) + '">' +
        "<label>Proxy URL</label>" +
        '<input id="dsProxy" type="text" placeholder="' + esc(DEFAULTS.proxy) + '" value="' + esc(lsGet(LS.proxy)) + '">' +
        "<label>ClassX API base URL</label>" +
        '<input id="dsBase" type="text" placeholder="' + esc(DEFAULTS.base) + '" value="' + esc(lsGet(LS.base)) + '">' +
        '<p class="dv-hint">Stored only in this browser. If lectures fail with an auth error, paste a fresh token here. Leave fields empty to use defaults.</p>' +
        '<div class="dv-row"><button class="dv-btn" data-s="save">Save</button><button class="dv-btn ghost" data-s="reset">Reset</button></div>' +
      "</div>";
    document.body.appendChild(settingsEl);
    pushLayer();
    settingsEl.addEventListener("click", function (e) {
      var t = e.target;
      if (t === settingsEl || t.dataset.s === "close") return goBack();
      if (t.dataset.s === "save") {
        lsSet(LS.token, settingsEl.querySelector("#dsToken").value.trim());
        lsSet(LS.proxy, settingsEl.querySelector("#dsProxy").value.trim());
        lsSet(LS.base, settingsEl.querySelector("#dsBase").value.trim());
        toast("API settings saved");
        goBack();
        if (viewEl && !viewEl.hidden) { S.live = null; loadFolder(); }
      } else if (t.dataset.s === "reset") {
        lsSet(LS.token, ""); lsSet(LS.proxy, ""); lsSet(LS.base, "");
        settingsEl.querySelector("#dsToken").value = ""; settingsEl.querySelector("#dsProxy").value = ""; settingsEl.querySelector("#dsBase").value = "";
        toast("Settings reset to defaults");
      }
    });
  }
  function closeSettingsEl() { if (settingsEl) { settingsEl.remove(); settingsEl = null; } }

  /* ------------------------------------------------- history (back button) */
  window.addEventListener("popstate", function (e) {
    if (settingsEl) return closeSettingsEl();
    if (pdfEl) return closePdfEl();
    if (isPlayerOpen()) return destroyPlayer();
    if (viewEl && !viewEl.hidden) {
      var depth = (e.state && e.state.disha && e.state.depth) || 0;
      if (depth >= 1 && depth < S.path.length) { S.path.length = depth; S.search = ""; renderPane(); loadFolder(); }
      else if (depth < 1) closeBatchView();
    }
  });

  /* ------------------------------------------------------------------ icons */
  function ico(n) {
    var p = {
      back: '<path d="M15 5l-7 7 7 7"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.7a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.7a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      pdf: '<path d="M6 3h8l5 5v13H6Z"/><path d="M14 3v5h5M9 14h6M9 17h6"/>',
      play: '<path d="M8 5v14l11-7Z" fill="currentColor"/>',
      open: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
      rew: '<path d="M11 6 5 12l6 6M19 6l-6 6 6 6"/>',
      fwd: '<path d="m13 6 6 6-6 6M5 6l6 6-6 6"/>',
      pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>',
      fs: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
    }[n] || "";
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">' + p + "</svg>";
  }

  /* ------------------------------------------------------ settings entry UI */
  function injectSettingsButtons() {
    var actions = document.querySelector(".nav-actions");
    if (actions && !document.getElementById("dishaSettingsBtn")) {
      var b = document.createElement("button");
      b.className = "icon-btn"; b.id = "dishaSettingsBtn"; b.type = "button";
      b.setAttribute("aria-label", "API settings"); b.innerHTML = ico("gear");
      b.addEventListener("click", openSettings);
      actions.insertBefore(b, actions.firstChild);
    }
    var f = document.getElementById("dishaFooterSettings");
    if (f) f.addEventListener("click", openSettings);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectSettingsButtons);
  else injectSettingsButtons();

  /* ----------------------------------------------------------------- export */
  window.Disha = {
    open: openBatchView,
    openSettings: openSettings,
    normalizeBatch: normalizeBatch,
    loadLocal: loadLocal,
    loadRemote: loadRemote,
    merge: mergeBatches,
    config: cfg
  };
})();
