/* ================= CONFIG ================= */
const API = "/api";
const qs = id => document.getElementById(id);
const show = el => el.classList.remove("hidden");
const hide = el => el.classList.add("hidden");

/* ================= STATE ================= */
let STATE = {
  me: null,
  config: {},
  fields: [],
  fieldsDraft: [],
  notes: "",
  users: [],
  reservations: [],
  dayReservationsAll: [],
  gallery: [],
  galleryDraft: [],
  closedDays: [],
  closedSlots: [],

};


let AUTO_REFRESH_TIMER = null;

function startAutoRefresh() {
  stopAutoRefresh();
  AUTO_REFRESH_TIMER = setInterval(async () => {
    try {
      // aggiorna prenotazioni (e quindi timeline, stato, ecc.)
      await loadReservations();

      // aggiorna crediti (solo se user)
      if (STATE.me && STATE.me.role === "user") {
        await refreshCredits();
      }
    } catch (e) {
      // se la sessione è scaduta o il server dorme, non blocchiamo la UI
      console.warn("Auto-refresh fallito", e);
    }
  }, 5_000);
}

function stopAutoRefresh() {
  if (AUTO_REFRESH_TIMER) clearInterval(AUTO_REFRESH_TIMER);
  AUTO_REFRESH_TIMER = null;
}

/* ================= DATE / TIME ================= */
function isPastDate(dateStr) {
  return dateStr < localISODate();
}

function localISODate(d = new Date()) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isPastTimeToday(dateStr, timeStr) {
  if (dateStr !== localISODate()) return false;
  return minutes(timeStr) <= nowMinutes();
}
function minutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function timeStr(m) {
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" +
         String(m % 60).padStart(2, "0");
}

function weatherEmoji(code) {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code <= 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌦️";
  if (code <= 99) return "⛈️";
  return "❓";
}

// ===== STATO CAMPO =====
function getFieldStatus(fieldId) {
  const now = nowMinutes();
  const slot = STATE.config.slotMinutes || 45;

  const current = STATE.dayReservationsAll.find(r => {
    if (r.fieldId !== fieldId) return false;
    const start = minutes(r.time);
    return now >= start && now < start + slot;
  });

  if (current) return { status: "playing", user: current.user };

  const todayHas = STATE.dayReservationsAll.some(r => r.fieldId === fieldId);
  if (todayHas) return { status: "busy" };

  return { status: "free" };
}

// ===== COUNTDOWN PROSSIMA PARTITA =====
function getNextMatchCountdown(fieldId) {
  const now = nowMinutes();

  const next = STATE.dayReservationsAll
    .filter(r => r.fieldId === fieldId)
    .map(r => minutes(r.time))
    .filter(t => t > now)
    .sort((a, b) => a - b)[0];

  return next ? next - now : null;
}


/* ================= API ================= */
async function api(path, options = {}) {
  const r = await fetch(API + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw j;
  return j;
}

/* ================= PUBLIC (LOGIN) ================= */
async function loadPublicLoginGallery() {
  try {
    const pub = await api("/public/config");
    STATE.gallery = pub.gallery || [];
    renderLoginGallery();
  } catch {}
}

async function loadWeather() {
  const box = qs("weatherBox");
  const row = qs("weatherRow");
  if (!box || !row) return;

  const CACHE_KEY = "weather_cache";
  const CACHE_TTL = 30 * 60 * 1000; // 30 minuti

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    const now = Date.now();

    // ✅ usa cache se valida
    if (cached && now - cached.time < CACHE_TTL) {
      renderWeather(cached.data);
      box.classList.remove("hidden");
      return;
    }

    // 🔄 fetch reale
    const data = await api("/weather");

    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ time: now, data })
    );

    renderWeather(data);
    box.classList.remove("hidden");

  } catch (e) {
    console.error("Errore meteo", e);
  }
}

function renderWeather(data) {
  const row = qs("weatherRow");
  row.innerHTML = "";

  for (let i = 0; i < 7; i++) {
    const d = new Date(data.daily.time[i]);
    const day = d.toLocaleDateString("it-IT", { weekday: "short" });

    const el = document.createElement("div");
    el.className = "weather-day";
    el.innerHTML = `
      ${day}
      <span class="weather-emoji">
        ${weatherEmoji(data.daily.weathercode[i])}
      </span>
    `;
    row.appendChild(el);
  }
}


/* ================= AUTH ================= */
async function login() {
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({
        username: qs("username").value.trim(),
        password: qs("password").value.trim()
      })
    });
    location.reload(); // 🔁 lascia che sia INIT a fare loadAll
  } catch {
  qs("loginErr").textContent = "Login fallito";
  show(qs("loginErr"));

  qs("username").classList.add("input-error");
  qs("password").classList.add("input-error");

  setTimeout(() => {
    qs("username").classList.remove("input-error");
    qs("password").classList.remove("input-error");
  }, 400);
  }
}

async function logout() {
  await api("/logout", { method: "POST" });
qs("loginBox").classList.add("login-success");

  location.reload();
}

/* ================= LOAD BASE ================= */
async function loadAll(setDateToday = false) {
show(qs("skeleton"));

  STATE.me = await api("/me");
  const pub = await api("/public/config");

  STATE.config = pub;
  STATE.fields = pub.fields || [];
// POPOLA SELECT CHIUSURE ORARIE
const sel = qs("closedSlotField");
if (sel) {
  sel.innerHTML = `<option value="*">Tutti i campi</option>`;
  STATE.fields.forEach(f => {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.name;
    sel.appendChild(o);
  });
}

const closed = await api("/public/closed-days");
STATE.closedDays = closed.days || [];

const closedSlotsRes = await api("/public/closed-slots");
STATE.closedSlots = closedSlotsRes.items || [];
  STATE.fieldsDraft = [...STATE.fields];
  STATE.notes = pub.notesText || "";
  STATE.gallery = pub.gallery || [];
  STATE.galleryDraft = [...STATE.gallery];

  hide(qs("loginBox"));
  show(qs("app"));
  show(qs("logoutBtn"));

  qs("welcome").textContent = `Ciao ${STATE.me.username}`;
  qs("creditsBox").textContent = `Crediti: ${STATE.me.credits}`;
  qs("roleBadge").textContent = STATE.me.role;
  qs("notesView").innerText = STATE.notes || "Nessuna comunicazione.";


  if (setDateToday || !qs("datePick").value) {
    qs("datePick").value = localISODate();
  }

renderFields();

// 👇 AGGIUNGI QUESTO
if (STATE.fields.length > 0) {
  qs("fieldSelect").value = STATE.fields[0].id;
}
  renderLoginGallery();

  if (STATE.me.role === "admin") {
    show(qs("adminMenu"));
    qs("cfgSlotMinutes").value = pub.slotMinutes;
    qs("addRangeBtn").onclick = () => addOpenRange();

    qs("cfgMaxPerDay").value = pub.maxBookingsPerUserPerDay;
    qs("cfgMaxActive").value = pub.maxActiveBookingsPerUser;
    qs("notesText").value = STATE.notes;
    renderFieldsAdmin();
    renderGalleryAdmin();
    await loadUsers();
  }

  await loadReservations();
hide(qs("skeleton"));


}



/* ================= RESERVATIONS ================= */
async function loadReservations() {
  const date = qs("datePick").value;

// ⛔ BLOCCO GIORNI CHIUSI
if (STATE.closedDays.includes(date)) {
  qs("bookBtn").disabled = true;
  qs("bookMsg").textContent = "⛔ Struttura chiusa per questa data";

  STATE.dayReservationsAll = [];
  STATE.reservations = [];

  renderTimeSelect();
  renderReservations();
  renderFieldInfo();
  return;
}

  // ❌ BLOCCO GIORNI PASSATI
  if (isPastDate(date)) {
    qs("bookBtn").disabled = true;
    qs("bookMsg").textContent = "❌ Non puoi prenotare una giornata passata";

    STATE.dayReservationsAll = [];
    STATE.reservations = [];

    renderTimeSelect();
    renderReservations();
    renderFieldInfo();
    return;
  }

  qs("bookBtn").disabled = false;
  qs("bookMsg").textContent = "";

  const res = await api(`/reservations?date=${date}`);

  STATE.dayReservationsAll = res.items || [];
  STATE.reservations =
    STATE.me.role === "admin"
      ? STATE.dayReservationsAll
      : STATE.dayReservationsAll.filter(r => r.user === STATE.me.username);

  renderTimeSelect();
  renderReservations();
  renderFieldInfo();
}

function renderFieldInfo() {
  const fieldId = qs("fieldSelect")?.value;
  if (!fieldId) return;
  const box = qs("fieldInfo");

  if (!box) return;

  const status = getFieldStatus(fieldId);
  const countdown = getNextMatchCountdown(fieldId);

  let statusText = "🟢 Campo libero";
  if (status.status === "playing") statusText = "🟡 Partita in corso";
  if (status.status === "busy") statusText = "🔴 Campo occupato oggi";

  let countdownText = "Nessuna partita prevista";
  if (countdown !== null) {
    countdownText = `⏳ Prossima partita tra ${countdown} min`;
  }

  box.innerHTML = `
  <div class="field-status glow">${statusText}</div>
  <div class="field-countdown">${countdownText}</div>

  <!-- TIMELINE GIORNATA -->
  <div id="timeline" class="timeline"></div>
`;

renderTimeline(fieldId);
}



function renderTimeSelect() {
  const sel = qs("timeSelect");
  sel.innerHTML = "";

  const slot = STATE.config.slotMinutes || 45;
const field = qs("fieldSelect").value;
const isToday = qs("datePick").value === localISODate();

const taken = new Set(
  STATE.dayReservationsAll
    .filter(r => r.fieldId === field)
    .map(r => r.time)
);

// usa SOLO le fasce aperte
const start = minutes(STATE.config.dayStart);
const end   = minutes(STATE.config.dayEnd);

for (let m = start; m + slot <= end; m += slot) {
  const t = timeStr(m);
  const o = document.createElement("option");
  o.value = t;

  if (taken.has(t)) {
    o.textContent = `${t} ❌ Occupato`;
    o.disabled = true;
  } else {
    o.textContent = `${t} ✅ Libero`;
  }

  sel.appendChild(o);
}
}


function renderTimeline(fieldId) {
  const slotMinutes = STATE.config.slotMinutes || 45;
  const now = nowMinutes();
  const box = qs("timeline");
  if (!box) return;
  box.innerHTML = "";

  const slots = [];

  // 🔁 usa SOLO le fasce aperte
  const start = minutes(STATE.config.dayStart);
const end   = minutes(STATE.config.dayEnd);

for (let m = start; m + slotMinutes <= end; m += slotMinutes) {
  const t = timeStr(m);
  const el = document.createElement("div");

  el.dataset.start = m;
  el.innerHTML = `<div class="slot-time">${t}</div>`;

  box.appendChild(el);
  slots.push(el);
}


  // se non ci sono slot → niente marker
  if (slots.length === 0) return;

  // === MARKER ORA ===
  const marker = document.createElement("div");
  marker.className = "now-marker";
  box.appendChild(marker);

  const first = slots[0].dataset.start;
  const last = slots[slots.length - 1].dataset.start;

  if (now < first || now > Number(last) + slotMinutes) {
    marker.style.display = "none";
    return;
  }

  // trova lo slot corrente
  const currentSlot = slots.find(s => {
    const m = Number(s.dataset.start);
    return now >= m && now < m + slotMinutes;
  });

  if (!currentSlot) {
    marker.style.display = "none";
    return;
  }

  const slotRect = currentSlot.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();

  marker.style.display = "block";
  marker.style.left =
    `${slotRect.left - boxRect.left + slotRect.width / 2}px`;
  marker.style.top =
    `${slotRect.top - boxRect.top + (slotRect.height - marker.offsetHeight) / 2}px`;
}

/* ===== PRENOTA (UI OTTIMISTICA) ===== */
async function book() {
  const fieldId = qs("fieldSelect").value;
  const date = qs("datePick").value;
  const time = qs("timeSelect").value;

  // ❌ BLOCCO GIORNI PASSATI
  if (isPastDate(date)) {
  qs("bookMsg").textContent = "❌ Non puoi prenotare un giorno passato";
  return;
}

if (isPastTimeToday(date, time)) {
  qs("bookMsg").textContent = "❌ Orario già passato";
  return;
}


  qs("bookBtn").disabled = true;
  qs("bookBtn").textContent = "Salvataggio…";

  // UI immediata
  STATE.reservations.push({
    id: "tmp_" + Date.now(),
    fieldId,
    date,
    time,
    user: STATE.me.username
  });
  renderReservations();
  renderTimeSelect();

  try {
    await api("/reservations", {
      method: "POST",
      body: JSON.stringify({ fieldId, date, time })
    });

    qs("bookMsg").textContent = "Prenotazione effettuata ✅";
    await refreshCredits();
    await loadReservations();

  } catch (e) {
  qs("bookMsg").textContent =
    e?.error === "FIELD_CLOSED_TIME"
      ? `⛔ Campo chiuso in questo orario${e.reason ? ": " + e.reason : ""}`
      : e?.error === "ACTIVE_BOOKING_LIMIT"
      ? "Hai raggiunto il limite di prenotazioni attive"
      : e?.error === "MAX_PER_DAY_LIMIT"
      ? "Hai raggiunto il limite di prenotazioni per questo giorno"
      : "Errore prenotazione";

  // 🔄 ricarica stato reale dal server
  await loadReservations();
}



  qs("bookBtn").disabled = false;
  qs("bookBtn").textContent = "Prenota";
}

async function deleteReservation(id) {
  if (!confirm("Cancellare la prenotazione?")) return;

  // UI immediata
  STATE.reservations = STATE.reservations.filter(r => r.id !== id);
  renderReservations();
  renderTimeSelect();

  try {
    await api(`/reservations/${id}`, { method: "DELETE" });
    await refreshCredits();
    await loadReservations();
  } catch {
    await loadReservations();
  }
}

function renderReservations() {
  const list = qs("reservationsList");
  list.innerHTML = "";

  if (STATE.reservations.length === 0) {
    list.textContent = "Nessuna prenotazione.";
    return;
  }

  STATE.reservations.forEach(r => {
    const d = document.createElement("div");
    d.className = "item";

    d.textContent =
      STATE.me.role === "admin"
        ? `${r.time} – ${r.fieldId} – 👤 ${r.user}`
        : `${r.time} – ${r.fieldId}`;

    if (STATE.me.role === "admin" || r.user === STATE.me.username) {
      const b = document.createElement("button");
      b.className = "btn-ghost";
      b.textContent = "❌ Cancella";
      b.onclick = () => deleteReservation(r.id);
      d.appendChild(b);
    }

    list.appendChild(d);
  });
}

/* ================= CREDITI ================= */
async function refreshCredits() {
  const me = await api("/me");
  STATE.me.credits = me.credits;
  qs("creditsBox").textContent = `Crediti: ${me.credits}`;
}

/* ================= FIELDS ================= */
function renderFields() {
  const s = qs("fieldSelect");
  s.innerHTML = "";
  STATE.fields.forEach(f => {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.name;
    s.appendChild(o);
  });
}
function renderFieldsAdmin() {
  const l = qs("fieldsList");
  l.innerHTML = "";
  STATE.fieldsDraft.forEach((f, i) => {
    const d = document.createElement("div");
    d.className = "item";
    d.textContent = `${f.id} – ${f.name}`;

    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.textContent = "🗑️";
    b.onclick = () => {
      STATE.fieldsDraft.splice(i, 1);
      renderFieldsAdmin();
    };

    d.appendChild(b);
    l.appendChild(d);
  });
}
async function addField() {
  const id = qs("newFieldId").value.trim();
  const name = qs("newFieldName").value.trim();
  if (!id || !name) return;
  STATE.fieldsDraft.push({ id, name });
  qs("newFieldId").value = "";
  qs("newFieldName").value = "";
  renderFieldsAdmin();
}
async function saveFields() {
  await api("/admin/fields", {
    method: "PUT",
    body: JSON.stringify({ fields: STATE.fieldsDraft })
  });

  // 🔄 ricarica campi aggiornati
  const pub = await api("/public/config");
  STATE.fields = pub.fields || [];
  STATE.fieldsDraft = [...STATE.fields];

  renderFields();
  renderFieldsAdmin();

  alert("Campi aggiornati ✅");
}

/* ================= NOTES ================= */
async function saveNotes() {
  await api("/admin/notes", {
    method: "PUT",
    body: JSON.stringify({ text: qs("notesText").value })
  });

  STATE.notes = qs("notesText").value;
  qs("notesView").innerText = STATE.notes || "Nessuna comunicazione.";


  alert("Note aggiornate ✅");
}


/* ================= CONFIG ================= */
async function saveConfig() {
  const ranges = [...document.querySelectorAll(".range-row")].map(r => ({
  start: r.querySelector(".rangeStart").value,
  end: r.querySelector(".rangeEnd").value
}));

await api("/admin/config", {
  method: "PUT",
  body: JSON.stringify({
  slotMinutes: Number(qs("cfgSlotMinutes").value),
  dayStart: qs("cfgDayStart").value,
  dayEnd: qs("cfgDayEnd").value,
  maxBookingsPerUserPerDay: Number(qs("cfgMaxPerDay").value),
  maxActiveBookingsPerUser: Number(qs("cfgMaxActive").value)
})

});


  // 🔄 ricarica config aggiornata
  const pub = await api("/public/config");
  STATE.config = pub;

  // 🔁 aggiorna UI che dipende dagli orari
await loadAll(true);   // forza ricarica data + config
await loadReservations(); // 🔴 QUESTO MANCAVA
renderTimeSelect();
renderFieldInfo();


  alert("Configurazione aggiornata ✅");
}
function addOpenRange(start = "08:00", end = "12:00") {
  const box = qs("openRanges");

  const row = document.createElement("div");
  row.className = "range-row";
  row.style.display = "flex";
  row.style.gap = "8px";

  row.innerHTML = `
    <input type="time" class="rangeStart" value="${start}">
    <input type="time" class="rangeEnd" value="${end}">
    <button class="btn-ghost">❌</button>
  `;

  row.querySelector("button").onclick = () => row.remove();
  box.appendChild(row);
}

/* ================= USERS ================= */

function renderUsers(filter = "") {
  const l = qs("usersList");
  l.innerHTML = "";

  STATE.users
    .filter(u =>
      u.username.toLowerCase().includes(filter.toLowerCase())
    )
    .forEach(u => {
      const d = document.createElement("div");
      d.className = "item";

      d.innerHTML = `
  <strong>${u.username}</strong> – crediti ${u.credits}
  <br>
  <input
    type="text"
    placeholder="Nuovo username"
    class="rename-input"
  >
`;


      // ✏️ CREDITI
      const edit = document.createElement("button");
      edit.className = "btn-ghost";
      edit.textContent = "✏️ Crediti";
      edit.onclick = async () => {
        const v = prompt("Nuovi crediti", u.credits);
        if (v === null) return;
        await api("/admin/users/credits", {
          method: "PUT",
          body: JSON.stringify({
            username: u.username,
            delta: v - u.credits
          })
        });
        loadUsers();
      };

      // ✏️ RINOMINA
      const rename = document.createElement("button");
      rename.className = "btn-ghost";
      rename.textContent = "✏️ Rinomina";
      rename.onclick = async () => {
        const newUsername = d
          .querySelector(".rename-input")
          .value.trim();

        if (!newUsername) {
          alert("Inserisci il nuovo username");
          return;
        }

        if (!confirm(`Rinominare ${u.username} in ${newUsername}?`)) return;

        await api("/admin/users/rename", {
          method: "POST",
          body: JSON.stringify({
            oldUsername: u.username,
            newUsername
          })
        });

        loadUsers();
      };

      // 🔑 RESET PASSWORD
      const reset = document.createElement("button");
      reset.className = "btn-ghost";
      reset.textContent = "🔑 Reset PW";
      reset.onclick = async () => {
        const newPw = prompt("Nuova password");
if (!newPw) return;

await api("/admin/users/password", {
  method: "PUT",
  body: JSON.stringify({
    username: u.username,
    newPassword: newPw
  })
});

        alert("Password resettata");
      };

      // ⛔ DISABILITA / ABILITA
      const toggle = document.createElement("button");
      toggle.className = "btn-ghost";
      toggle.textContent = u.disabled ? "✅ Abilita" : "⛔ Disabilita";
      toggle.onclick = async () => {
        await api("/admin/users/status", {
  method: "PUT",
  body: JSON.stringify({
    username: u.username,
    disabled: !u.disabled
  })
});

        loadUsers();
      };

      d.appendChild(edit);
      d.appendChild(rename);
      d.appendChild(reset);
      d.appendChild(toggle);

      l.appendChild(d);
    });
}

async function loadUsers() {
  const r = await api("/admin/users");
  STATE.users = r.items;
  renderUsers();
}

async function addCreditsToAllUsers() {
  if (!confirm("Aggiungere 100 crediti a TUTTI gli utenti?")) return;

  try {
    const res = await api("/admin/users/add-credits-all", {
      method: "POST",
      body: JSON.stringify({ amount: 100 })
    });

    alert(`✅ Crediti aggiunti a ${res.updated} utenti`);
    loadUsers();
  } catch (e) {
    alert("❌ Errore durante l’operazione");
  }
}

/* ================= GALLERY ================= */
function renderLoginGallery() {
  const box = qs("loginGallery");
  if (!box) return;

  box.innerHTML = "";

  STATE.gallery.forEach(g => {
    if (!g.url || !g.link) return;

    const wrap = document.createElement("div");
    wrap.className = "login-gallery-item";

    const a = document.createElement("a");
    a.href = g.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", e => e.stopPropagation());

    const img = document.createElement("img");
    img.src = g.url;
    img.loading = "lazy";

    a.appendChild(img);
    wrap.appendChild(a);

    // 👇 DIDASCALIA
    if (g.caption) {
      const cap = document.createElement("div");
      cap.className = "login-gallery-caption";
      cap.textContent = g.caption;
      wrap.appendChild(cap);
    }

    box.appendChild(wrap);
  });
}

function renderGalleryAdmin() {
  const l = qs("galleryList");
  l.innerHTML = "";
  STATE.galleryDraft.forEach((g, i) => {
    const d = document.createElement("div");
    d.className = "item";
    d.textContent = g.caption || g.url;

    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.textContent = "🗑️";
    b.onclick = () => {
      STATE.galleryDraft.splice(i, 1);
      renderGalleryAdmin();
    };

    d.appendChild(b);
    l.appendChild(d);
  });
}
function addGalleryItem() {
  if (STATE.galleryDraft.length >= 10) return alert("Max 10 immagini");
  const url = qs("galleryUrl").value.trim();
  const cap = qs("galleryCaption").value.trim();
  const link = qs("galleryLink").value.trim();
  if (!url || !link.startsWith("http")) {
    alert("URL e link devono essere validi");
    return;
  }
  STATE.galleryDraft.push({ url, caption: cap, link });
  qs("galleryUrl").value = "";
  qs("galleryCaption").value = "";
  qs("galleryLink").value = "";
  renderGalleryAdmin();
}
async function saveGallery() {
  await api("/admin/gallery", {
    method: "PUT",
    body: JSON.stringify({ images: STATE.galleryDraft })
  });
}
function renderClosedDays() {
  const list = qs("closedDaysList");
  list.innerHTML = "";

  STATE.closedDays.forEach(d => {
    const el = document.createElement("div");
    el.className = "item";
    el.textContent = d;

    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.textContent = "❌";
    b.onclick = async () => {
      await api(`/admin/closed-days/${d}`, { method: "DELETE" });
      STATE.closedDays = STATE.closedDays.filter(x => x !== d);
      renderClosedDays();
    };

    el.appendChild(b);
    list.appendChild(el);
  });
}
const addClosedDayBtn = qs("addClosedDayBtn");
if (addClosedDayBtn) {
  addClosedDayBtn.onclick = async () => {
    const date = qs("closedDate").value;
    const reason = qs("closedReason").value;
    if (!date) return;

    await api("/admin/closed-days", {
      method: "POST",
      body: JSON.stringify({ date, reason })
    });

    STATE.closedDays.push(date);
    renderClosedDays();
  };
}

const addClosedRangeBtn = qs("addClosedRangeBtn");
if (addClosedRangeBtn) {
  addClosedRangeBtn.onclick = async () => {
    const start = qs("closedStart").value;
    const end = qs("closedEnd").value;
    const reason = qs("closedRangeReason").value;

    if (!start || !end) {
      alert("Seleziona data inizio e fine");
      return;
    }

    if (!confirm(`Chiudere il periodo dal ${start} al ${end}?`)) return;

    await api("/admin/closed-days/range", {
      method: "POST",
      body: JSON.stringify({
        startDate: start,
        endDate: end,
        reason
      })
    });

    await loadAll();
    renderTimeSelect();
  };
}


  
/* ================= CLOSED SLOTS (CHIUSURE ORARIE) ================= */

async function loadClosedSlots() {
  const r = await api("/admin/closed-slots");
  const box = qs("closedSlotsList");
  box.innerHTML = "";

  r.items.forEach(c => {
    const d = document.createElement("div");
    d.className = "item";
    d.innerHTML = `
      <b>${c.fieldId === "*" ? "Tutti i campi" : c.fieldId}</b><br>
      ${c.startDate} → ${c.endDate}<br>
      ${c.startTime} – ${c.endTime}<br>
      <i>${c.reason || ""}</i>
      <button class="btn-ghost">❌</button>
    `;

    d.querySelector("button").onclick = async () => {
  await api(`/admin/closed-slots/${c.id}`, { method: "DELETE" });

  await loadClosedSlots();

  // 🔄 RICARICA STATO + ORARI
  await loadAll();
  renderTimeSelect();
};


    box.appendChild(d);
  });
}

const addClosedSlotBtn = qs("addClosedSlotBtn");
if (addClosedSlotBtn) {
  addClosedSlotBtn.onclick = async () => {
    try {
      await api("/admin/closed-slots", {
        method: "POST",
        body: JSON.stringify({
          fieldId: qs("closedSlotField").value,
          startDate: qs("closedSlotStartDate").value,
          endDate: qs("closedSlotEndDate").value,
          startTime: qs("closedSlotStartTime").value,
          endTime: qs("closedSlotEndTime").value,
          reason: qs("closedSlotReason").value
        })
      });

      await loadClosedSlots();
      await loadAll();
      renderTimeSelect();

      alert("Chiusura oraria salvata ✅");
    } catch (e) {
      alert(`Errore salvataggio ❌ (${e?.error || "UNKNOWN"})`);
    }
  };
}



/* ================= ADMIN NAV ================= */
function openAdmin(id) {
  [
    "adminMenu",
    "adminConfig",
    "adminNotes",
    "adminFields",
    "adminUsers",
    "adminGallery",
    "adminClosedDays",
    "adminClosedSlots" // 👈 NUOVO
  ].forEach(s => hide(qs(s)));

  show(qs(id));
}

/* ================= INIT ================= */
document.addEventListener("DOMContentLoaded", () => {
const appLoader = qs("appLoader");

  qs("loginBtn").onclick = login;
  qs("logoutBtn").onclick = logout;
  qs("bookBtn").onclick = book;

  qs("datePick").onchange = loadReservations;
  qs("fieldSelect").onchange = () => {
    renderTimeSelect();
    renderFieldInfo();
  };

  qs("btnAdminConfig").onclick = () => openAdmin("adminConfig");
  qs("btnAdminNotes").onclick = () => openAdmin("adminNotes");
  qs("btnAdminFields").onclick = () => openAdmin("adminFields");
  qs("btnAdminUsers").onclick = () => openAdmin("adminUsers");
const addAllBtn = qs("addCreditsAllBtn");
if (addAllBtn) {
  addAllBtn.onclick = addCreditsToAllUsers;
}


  qs("btnAdminGallery").onclick = () => openAdmin("adminGallery");

const btnAdminClosedDays = qs("btnAdminClosedDays");
if (btnAdminClosedDays) {
  btnAdminClosedDays.onclick = () => {
    openAdmin("adminClosedDays");
    renderClosedDays();
  };
}

const btnAdminClosedSlots = qs("btnAdminClosedSlots");
if (btnAdminClosedSlots) {
  btnAdminClosedSlots.onclick = () => {
    openAdmin("adminClosedSlots");
    loadClosedSlots();
  };
}


  document.querySelectorAll(".backAdmin")
    .forEach(b => b.onclick = () => openAdmin("adminMenu"));

  qs("saveConfigBtn").onclick = saveConfig;
  qs("saveNotesBtn").onclick = saveNotes;
  qs("addFieldBtn").onclick = addField;
  qs("saveFieldsBtn").onclick = saveFields;
  qs("addGalleryBtn").onclick = addGalleryItem;
  qs("saveGalleryBtn").onclick = saveGallery;

  // login gallery pubblica
  loadPublicLoginGallery();

  // avvio APP
loadAll(true)
  .then(() => {
    loadWeather();


    startAutoRefresh();
  if (appLoader) {
  appLoader.classList.add("hide");
  setTimeout(() => appLoader.remove(), 450);
}
  })
  .catch(err => {
    console.warn("INIT ERROR (non loggato)", err);

    // 👉 MOSTRA LOGIN, NASCONDE APP E LOADER
    show(qs("loginBox"));
    hide(qs("app"));
    hide(qs("logoutBtn"));
    if (appLoader) {
  appLoader.classList.add("hide");
  setTimeout(() => appLoader.remove(), 300);
}

  });
qs("userSearch").addEventListener("input", e => {
  renderUsers(e.target.value);
});

  // 🔁 KEEP SERVER SVEGLIO (Render free)
  setInterval(() => {
    fetch("/api/health").catch(() => {});
  }, 5 * 60 * 1000);
});
