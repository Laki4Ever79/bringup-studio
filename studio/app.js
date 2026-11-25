// Bringup Studio front end: plain DOM, one WebSocket, everything else is iframes of server previews.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = async (path, init) => {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).message ?? r.statusText), { status: r.status });
  return r.json();
};

const state = {
  view: "board", element: null, variants: null, theme: "light", width: "1280", lang: "en", speed: 1,
  selected: null, // {element, variant}
  bump: {}, // element -> reload counter
  elements: [], feedback: [], pinAt: null,
};

function load() {
  try { Object.assign(state, JSON.parse(localStorage.getItem("studio") ?? "{}")); } catch {}
  const h = location.hash.slice(1).split("/");
  if (["board", "page", "motion"].includes(h[0])) { state.view = h[0]; if (h[1]) state.element = h[1]; }
}
function save() {
  try { localStorage.setItem("studio", JSON.stringify({ theme: state.theme, width: state.width, lang: state.lang })); } catch {}
  const hash = `#${state.view}${state.element && state.view !== "page" ? "/" + state.element : ""}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

// ---- toggles ------------------------------------------------------------------------------------------
function syncToggles() {
  for (const seg of $$(".seg")) {
    const key = seg.dataset.toggle;
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(String(state[key]) === b.dataset.v));
  }
  for (const b of $$(".views button")) b.setAttribute("aria-selected", String(b.dataset.view === state.view));
}
for (const seg of $$(".seg")) seg.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const key = seg.dataset.toggle;
  state[key] = key === "speed" ? Number(b.dataset.v) : b.dataset.v;
  syncToggles(); save();
  if (key !== "speed") render();
});
for (const b of $$(".views button")) b.addEventListener("click", () => { state.view = b.dataset.view; state.variants = null; render(); });

// ---- elements list ------------------------------------------------------------------------------------
async function refreshElements() {
  state.elements = await api("/api/elements");
  const kinds = await Promise.all(state.elements.map((id) => api(`/api/elements/${id}`).then((e) => e.kind).catch(() => "?")));
  if (!state.element || !state.elements.includes(state.element)) state.element = state.elements[0] ?? null;
  $("#elements").innerHTML = state.elements.map((id, i) =>
    `<li><button data-id="${id}" aria-current="${id === state.element}">${id}<small>${kinds[i]}</small></button></li>`).join("");
  const snaps = await api("/api/snapshots").catch(() => []);
  $("#snapshots").innerHTML = snaps.length ? snaps.map((s) => `<li>${s}</li>`).join("") : "<li>none yet</li>";
}
$("#elements").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  state.element = b.dataset.id; state.variants = null;
  for (const x of $$("#elements button")) x.setAttribute("aria-current", String(x === b));
  render();
});

const previewUrl = (id, variant, theme) => {
  const p = new URLSearchParams({ theme, lang: state.lang, v: String(state.bump[id] ?? 0) });
  if (variant && variant !== "base") p.set("variant", variant);
  return `/preview/element/${id}?${p}`;
};

// ---- board ----------------------------------------------------------------------------------------------
async function renderBoard() {
  const tiles = $("#tiles");
  if (!state.element) { tiles.innerHTML = `<p class="hint">No elements yet. Claude adds them through MCP.</p>`; return; }
  const el = await api(`/api/elements/${state.element}`);
  const names = state.variants?.length ? state.variants : ["base", ...Object.keys(el.variants)];
  const themes = state.theme === "both" ? ["light", "dark"] : [state.theme];
  tiles.style.setProperty("--tile", state.width === "360" ? "360px" : "280px");
  tiles.style.setProperty("--tile-h", state.width === "360" ? "300px" : "220px");
  const picked = new Set(state.feedback.filter((f) => f.kind === "pick" && f.element === el.id).map((f) => f.variant ?? "base"));
  tiles.innerHTML = names.flatMap((v) => themes.map((t) => `
    <figure class="tile${picked.has(v) ? " picked" : ""}" data-variant="${v}" data-theme="${t}"
      aria-selected="${state.selected?.element === el.id && state.selected?.variant === v}">
      <iframe src="${previewUrl(el.id, v, t)}" title="${el.id} ${v} ${t}" loading="lazy"></iframe>
      <div class="hit" tabindex="0" role="button" aria-label="select ${v}"></div>
      <figcaption><span>${v}${themes.length > 1 ? " · " + t : ""}</span><b>${picked.has(v) ? "picked" : ""}</b></figcaption>
    </figure>`)).join("");
  drawPins();
}

function drawPins() {
  for (const p of $$(".pin")) p.remove();
  const comments = state.feedback.filter((f) => f.kind === "comment" && f.element === state.element && f.x != null);
  comments.forEach((c, i) => {
    for (const tile of $$(`.tile[data-variant="${c.variant ?? "base"}"]`)) {
      const pin = document.createElement("i");
      pin.className = "pin"; pin.textContent = String(i + 1); pin.title = c.text ?? "";
      pin.style.left = c.x + "px"; pin.style.top = c.y + "px";
      tile.appendChild(pin);
    }
  });
}

$("#tiles").addEventListener("click", (e) => {
  const hit = e.target.closest(".hit");
  if (!hit) return;
  const tile = hit.closest(".tile");
  select(tile.dataset.variant);
  if (e.altKey) {
    const r = hit.getBoundingClientRect();
    state.pinAt = { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top), variant: tile.dataset.variant };
    $("#comment").classList.add("active");
    $("#comment-text").placeholder = `Comment at ${state.pinAt.x},${state.pinAt.y} on ${tile.dataset.variant}…`;
    $("#comment-text").focus();
  }
});
$("#tiles").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".hit")) e.target.click(); });

function select(variant) {
  state.selected = { element: state.element, variant };
  $("#selected").textContent = `${state.element} / ${variant}`;
  for (const t of $$(".tile")) t.setAttribute("aria-selected", String(t.dataset.variant === variant));
}

// ---- page + motion --------------------------------------------------------------------------------------
function renderPage() {
  const f = $("#pageframe");
  f.style.width = state.width + "px";
  const src = `/preview/page?theme=${state.theme === "dark" ? "dark" : "light"}&lang=${state.lang}&v=${Date.now()}`;
  f.src = src;
}

let motion = { anims: [], end: 1000, t: 0, playing: true, raf: 0 };
async function renderMotion() {
  if (!state.element) return;
  const el = await api(`/api/elements/${state.element}`);
  const f = $("#motionframe");
  f.onload = () => {
    const doc = f.contentDocument;
    motion.anims = doc.getAnimations();
    motion.end = Math.max(100, ...motion.anims.map((a) => {
      const end = a.effect.getComputedTiming().endTime;
      return Number.isFinite(end) ? end : a.effect.getComputedTiming().duration;
    }));
    for (const a of motion.anims) a.pause();
    $("#scrub").max = String(Math.round(motion.end));
    const ms = (s) => (s ? (s.endsWith("ms") ? parseFloat(s) : parseFloat(s) * 1000) : 0);
    $("#ticks").innerHTML = el.motion.flatMap((t) => t.keyframes.map((k) =>
      `<i style="left:${((ms(t.delay) + k.offset * ms(t.duration)) / motion.end) * 100}%"></i>`)).join("");
    motion.t = 0; seek(0);
  };
  f.src = previewUrl(el.id, state.selected?.element === el.id ? state.selected.variant : "base", state.theme === "dark" ? "dark" : "light");
}
function seek(t) {
  motion.t = t;
  for (const a of motion.anims) a.currentTime = t;
  $("#scrub").value = String(Math.round(t));
  $("#time").textContent = `${Math.round(t)} ms`;
}
let last = 0;
function tick(now) {
  if (state.view === "motion" && motion.playing && motion.anims.length) {
    const dt = last ? (now - last) * state.speed : 0;
    let t = motion.t + dt;
    if (t > motion.end + 400) t = 0; // short hold on the last frame, then loop
    seek(Math.min(t, motion.end));
    motion.t = t;
  }
  last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
$("#play").addEventListener("click", () => { motion.playing = !motion.playing; $("#play").textContent = motion.playing ? "❚❚" : "▶"; });
$("#scrub").addEventListener("input", (e) => { motion.playing = false; $("#play").textContent = "▶"; seek(Number(e.target.value)); });

// ---- render dispatcher ----------------------------------------------------------------------------------
async function render() {
  syncToggles(); save();
  for (const v of ["board", "page", "motion"]) $(`#view-${v}`).hidden = v !== state.view;
  try {
    if (state.view === "board") await renderBoard();
    else if (state.view === "page") renderPage();
    else await renderMotion();
  } catch (e) { console.warn(e); }
}

// ---- feedback -------------------------------------------------------------------------------------------
async function sendFeedback(body) {
  const f = await api("/api/feedback", { method: "POST", body: JSON.stringify(body) });
  return f;
}
$("#pick").addEventListener("click", () => {
  if (!state.selected) return flash("Select a tile first.");
  sendFeedback({ kind: "pick", element: state.selected.element, variant: state.selected.variant, view: state.view });
});
$("#more").addEventListener("click", () => {
  if (!state.selected) return flash("Select a tile first.");
  sendFeedback({ kind: "more", element: state.selected.element, variant: state.selected.variant });
});
$("#comment-send").addEventListener("click", async () => {
  const text = $("#comment-text").value.trim();
  if (!text) return;
  const pin = state.pinAt;
  await sendFeedback({
    kind: "comment", text, view: state.view,
    element: state.selected?.element ?? state.element ?? undefined,
    variant: pin?.variant ?? state.selected?.variant,
    ...(pin ? { x: pin.x, y: pin.y } : {}),
  });
  $("#comment-text").value = ""; state.pinAt = null;
  $("#comment").classList.remove("active");
  $("#comment-text").placeholder = "Comment on the selected tile…";
});
function addFeed(f) {
  if (state.feedback.some((x) => x.seq === f.seq)) return;
  state.feedback.push(f);
  const li = document.createElement("li");
  const what = f.kind === "comment" ? `“${f.text}”` : f.kind === "generate" ? `generated ${f.meta?.count ?? ""}` : f.kind;
  li.innerHTML = `<b>${f.element ?? ""}${f.variant ? "/" + f.variant : ""}</b> ${what}`;
  $("#feed").prepend(li);
  if (f.element === state.element && state.view === "board") {
    drawPins();
    if (f.kind === "pick") for (const t of $$(`.tile[data-variant="${f.variant ?? "base"}"]`)) { t.classList.add("picked"); t.querySelector("figcaption b").textContent = "picked"; }
  }
}

// ---- generate -------------------------------------------------------------------------------------------
async function updateEstimate() {
  const p = $("#gen-provider").value, n = $("#gen-count").value;
  try {
    const { usd } = await api(`/api/gen/estimate?provider=${p}&count=${n}`);
    $("#gen").textContent = `Generate ${n} · ~$${usd.toFixed(2)}`;
  } catch { $("#gen").textContent = `Generate ${n}`; }
}
async function updateSpend() {
  try {
    const s = await api("/api/spend");
    $("#spend").textContent = `Image spend: today $${s.today.toFixed(2)} · all time $${s.all.toFixed(2)}`;
  } catch { $("#spend").textContent = "Image spend: –"; }
}
async function updateRefs() {
  try {
    const refs = await api("/api/refs");
    $("#refs").innerHTML = refs.slice(-8).reverse().map((r) => `<a href="/refs/${r}" target="_blank"><img src="/refs/${r}" alt="${r}" loading="lazy"></a>`).join("");
  } catch {}
}
$("#gen-provider").addEventListener("change", updateEstimate);
$("#gen-count").addEventListener("change", updateEstimate);
$("#gen").addEventListener("click", async () => {
  const prompt = $("#gen-prompt").value.trim();
  if (!prompt) return flash("Write a prompt first.");
  const b = $("#gen"); b.disabled = true; const label = b.textContent; b.textContent = "Generating…";
  try {
    await api("/api/gen", { method: "POST", body: JSON.stringify({ prompt, provider: $("#gen-provider").value, count: Number($("#gen-count").value) }) });
    await Promise.all([updateRefs(), updateSpend()]);
  } catch (e) { flash(`Generate failed: ${e.message}`); }
  b.disabled = false; b.textContent = label;
});

// ---- status / note / ws ---------------------------------------------------------------------------------
let noteTimer;
function flash(text, ms = 6000) {
  const n = $("#note"); n.textContent = text; n.hidden = false;
  clearTimeout(noteTimer); noteTimer = setTimeout(() => (n.hidden = true), ms);
}
function setStatus(s) {
  const holder = s.holder ?? s.session;
  if (holder !== undefined) $("#status .who").textContent = holder ?? "idle";
  if (s.text !== undefined) $("#status .text").textContent = s.text;
  $("#status").classList.toggle("busy", Boolean(holder));
}

function connect(delay = 500) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { $("#conn").dataset.state = "open"; delay = 500; };
  ws.onclose = () => { $("#conn").dataset.state = "closed"; setTimeout(() => connect(Math.min(delay * 2, 8000)), delay); };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "hello") {
      $("#project").textContent = m.project;
      if (m.status) setStatus(m.status);
      setStatus({ holder: m.holder });
    } else if (m.type === "reload") {
      if (m.element) state.bump[m.element] = (state.bump[m.element] ?? 0) + 1;
      else for (const id of state.elements) state.bump[id] = (state.bump[id] ?? 0) + 1;
      if (!m.element || !state.elements.includes(m.element)) await refreshElements();
      if (!m.element || m.element === state.element || state.view === "page") render();
    } else if (m.type === "show") {
      if (m.view) state.view = m.view;
      if (m.element) state.element = m.element;
      state.variants = m.variants ?? null;
      if (m.theme) state.theme = m.theme;
      if (m.lang) state.lang = m.lang;
      if (m.width) state.width = String(m.width);
      await refreshElements();
      await render();
      if (m.note) flash(m.note, 15000);
      window.focus();
    } else if (m.type === "status") setStatus(m);
    else if (m.type === "lock") setStatus({ holder: m.holder });
    else if (m.type === "feedback") addFeed(m.item);
    else if (m.type === "refs") { updateRefs(); updateSpend(); }
  };
}

load();
syncToggles();
(async () => {
  const fb = await api("/api/feedback?since=0").catch(() => ({ items: [] }));
  for (const f of fb.items.slice(-30)) addFeed(f);
  await refreshElements();
  await render();
  updateEstimate(); updateSpend(); updateRefs();
  connect();
})();
