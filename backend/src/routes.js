import express from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, FieldValue } from "./db.js";

let lastCleanup = 0;
const CLEANUP_COOLDOWN_MS = 60_000; // 1 minuto

const router = express.Router();

/* =================== MIDDLEWARE =================== */
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "NOT_AUTHENTICATED" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "NOT_AUTHORIZED" });
  }
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10
});

/* =================== UTILS =================== */
function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function localISODate() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

async function cleanupExpiredReservations() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_COOLDOWN_MS) return;
  lastCleanup = now;

  const cfgSnap = await db.collection("admin").doc("config").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const slotMinutes = Number(cfg.slotMinutes || 45);

  const today = localISODate();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  const snap = await db
    .collection("reservations")
    .where("date", "<=", today)
    .get();

  if (snap.empty) return;

  const batch = db.batch();

  snap.forEach(doc => {
    const r = doc.data();
    let expired = false;

    if (r.date < today) expired = true;

    if (r.date === today) {
      const end = timeToMinutes(r.time) + slotMinutes;
      if (end <= nowMinutes) expired = true;
    }

    if (expired) batch.delete(doc.ref);
  });

  await batch.commit();
}


/* =================== AUTH =================== */
router.post("/login", loginLimiter, async (req, res) => {
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });

  const { username, password } = parsed.data;
  const ref = db.collection("users").doc(username);
  const snap = await ref.get();

  if (!snap.exists) return res.status(401).json({ error: "INVALID_LOGIN" });

  const user = snap.data();
  if (user.disabled) return res.status(403).json({ error: "USER_DISABLED" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "INVALID_LOGIN" });

  req.session.user = {
    username,
    role: user.role || "user"
  };

  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", requireAuth, async (req, res) => {
  const username = req.session.user.username;
  const snap = await db.collection("users").doc(username).get();
  const u = snap.exists ? snap.data() : {};

  res.json({
    username,
    role: u.role || "user",
    credits: u.credits ?? 0,
    disabled: !!u.disabled
  });
});

/* =================== PUBLIC CONFIG =================== */
router.get("/public/config", async (req, res) => {
  const cfgSnap = await db.collection("admin").doc("config").get();
  const fieldsSnap = await db.collection("admin").doc("fields").get();
  const notesSnap = await db.collection("admin").doc("notes").get();
  const gallerySnap = await db.collection("admin").doc("gallery").get();

  const cfg = cfgSnap.exists ? cfgSnap.data() : {};

  res.json({
    slotMinutes: Number(cfg.slotMinutes || 45),
    dayStart: cfg.dayStart || "09:00",
    dayEnd: cfg.dayEnd || "20:00",
    maxBookingsPerUserPerDay: Number(cfg.maxBookingsPerUserPerDay || 1),
    maxActiveBookingsPerUser: Number(cfg.maxActiveBookingsPerUser || 1),
    fields: fieldsSnap.exists ? (fieldsSnap.data().fields || []) : [],
    notesText: notesSnap.exists ? (notesSnap.data().text || "") : "",
    gallery: gallerySnap.exists ? (gallerySnap.data().images || []) : []
  });
});

/* =================== RESERVATIONS =================== */
router.get("/reservations", requireAuth, async (req, res) => {
  await cleanupExpiredReservations(); // ⬅️ QUI

  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "BAD_DATE" });
  }

  const snap = await db.collection("reservations")
    .where("date", "==", date)
    .get();

  const items = [];
  snap.forEach(d => items.push({ id: d.id, ...d.data() }));
  res.json({ items });
});

router.post("/reservations", requireAuth, async (req, res) => {
  await cleanupExpiredReservations(); // ⬅️ QUI

  const schema = z.object({
    fieldId: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });

  const { fieldId, date, time } = parsed.data;
  const username = req.session.user.username;
  const isAdmin = req.session.user.role === "admin";

  const cfgSnap = await db.collection("admin").doc("config").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const slotMinutes = Number(cfg.slotMinutes || 45);
const maxPerDay = Number(cfg.maxBookingsPerUserPerDay || 1);
const maxActive = Number(cfg.maxActiveBookingsPerUser || 1);


  const today = localISODate();
const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

// ❌ BLOCCO GIORNI PASSATI
if (date < today) {
  return res.status(400).json({ error: "PAST_DATE_NOT_ALLOWED" });
}

// ❌ BLOCCO ORARI PASSATI (OGGI)
if (date === today) {
  const end = timeToMinutes(time) + slotMinutes;
  if (end <= nowMinutes) {
    return res.status(400).json({ error: "PAST_TIME_NOT_ALLOWED" });
  }
}


  /* 🔒 LIMITI PRENOTAZIONI (per giorno + attive totali) */
if (!isAdmin) {
  const userSnap = await db.collection("reservations")
    .where("user", "==", username)
    .get();

  let activeCount = 0;
  let perDayCount = 0;

  userSnap.forEach(doc => {
    const r = doc.data();

    // conteggio prenotazioni per la data selezionata
    if (r.date === date) {
      perDayCount++;
    }

    // conteggio prenotazioni "attive" (future + oggi non ancora finita)
    if (r.date > today) {
      activeCount++;
    } else if (r.date === today) {
      const end = timeToMinutes(r.time) + slotMinutes;
      if (end > nowMinutes) activeCount++;
    }
  });

  // limite per giorno (es. max 2 prenotazioni nella stessa data)
  if (perDayCount >= maxPerDay) {
    return res.status(403).json({ error: "MAX_PER_DAY_LIMIT" });
  }

  // limite prenotazioni attive totali (es. max 1 attiva)
  if (activeCount >= maxActive) {
    return res.status(403).json({ error: "ACTIVE_BOOKING_LIMIT" });
  }
}


  const id = `${fieldId}_${date}_${time}`;
  const ref = db.collection("reservations").doc(id);
  if ((await ref.get()).exists) {
    return res.status(409).json({ error: "SLOT_TAKEN" });
  }

  await ref.set({
    fieldId,
    date,
    time,
    user: username,
    createdAt: FieldValue.serverTimestamp()
  });

  if (!isAdmin) {
    await db.collection("users").doc(username)
      .update({ credits: FieldValue.increment(-1) });
  }

  res.json({ ok: true });
});

router.delete("/reservations/:id", requireAuth, async (req, res) => {
  const snap = await db.collection("reservations").doc(req.params.id).get();
  if (!snap.exists) return res.json({ ok: true });

  const r = snap.data();
  const username = req.session.user.username;
  const isAdmin = req.session.user.role === "admin";

  if (!isAdmin && r.user !== username) {
    return res.status(403).json({ error: "NOT_ALLOWED" });
  }

  const today = localISODate();

  /* recupero credito SOLO se futuro */
  if (!isAdmin && r.date > today) {
    await db.collection("users").doc(username)
      .update({ credits: FieldValue.increment(1) });
  }

  await snap.ref.delete();
  res.json({ ok: true });
});

/* =================== ADMIN =================== */
router.put("/admin/config", requireAdmin, async (req, res) => {
  await db.collection("admin").doc("config")
    .set(req.body || {}, { merge: true });
  res.json({ ok: true });
});

router.put("/admin/notes", requireAdmin, async (req, res) => {
  await db.collection("admin").doc("notes")
    .set({ text: req.body.text || "" }, { merge: true });
  res.json({ ok: true });
});

router.put("/admin/fields", requireAdmin, async (req, res) => {
  await db.collection("admin").doc("fields")
    .set({ fields: req.body.fields || [] }, { merge: true });
  res.json({ ok: true });
});

router.put("/admin/gallery", requireAdmin, async (req, res) => {
  const images = Array.isArray(req.body.images)
    ? req.body.images.slice(0, 10)
    : [];
  await db.collection("admin").doc("gallery")
    .set({ images }, { merge: true });
  res.json({ ok: true });
});

/* =================== ADMIN USERS =================== */
router.get("/admin/users", requireAdmin, async (req, res) => {
  const snap = await db.collection("users").get();
  const items = [];
  snap.forEach(d => {
    const u = d.data();
    items.push({
      username: d.id,
      role: u.role || "user",
      credits: u.credits ?? 0,
      disabled: !!u.disabled
    });
  });
  res.json({ items });
});

router.put("/admin/users/credits", requireAdmin, async (req, res) => {
  const { username, delta } = req.body;
  await db.collection("users").doc(username)
    .update({ credits: FieldValue.increment(delta) });
  res.json({ ok: true });
});

router.put("/admin/users/status", requireAdmin, async (req, res) => {
  const { username, disabled } = req.body;
  await db.collection("users").doc(username)
    .update({ disabled });
  res.json({ ok: true });
});

router.put("/admin/users/password", requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  const hash = await bcrypt.hash(newPassword, 10);
  await db.collection("users").doc(username)
    .update({ passwordHash: hash });
  res.json({ ok: true });
});

// ===== METEO (proxy backend per CSP) =====
router.get("/weather", async (req, res) => {
  try {
    const lat = 43.716;
    const lon = 13.218;

    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode&timezone=Europe/Rome`
    );

    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "WEATHER_ERROR" });
  }
});


export default router;
