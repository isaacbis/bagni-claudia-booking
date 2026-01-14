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
function minutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
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
  openRanges: cfg.openRanges || [
    { start: "09:00", end: "20:00" }
  ],
  maxBookingsPerUserPerDay: Number(cfg.maxBookingsPerUserPerDay || 1),
  maxActiveBookingsPerUser: Number(cfg.maxActiveBookingsPerUser || 1),
    fields: fieldsSnap.exists ? (fieldsSnap.data().fields || []) : [],
    notesText: notesSnap.exists ? (notesSnap.data().text || "") : "",
    gallery: gallerySnap.exists ? (gallerySnap.data().images || []) : []
  });
});

/* =================== RESERVATIONS =================== */
router.get("/reservations", requireAuth, async (req, res) => {
  await cleanupExpiredReservations();

  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "BAD_DATE" });
  }

  const snap = await db
    .collection("reservations")
    .where("date", "==", date)
    .get();

  const items = [];
  snap.forEach(d => items.push({ id: d.id, ...d.data() }));
  res.json({ items });
});

router.post("/reservations", requireAuth, async (req, res) => {
  await cleanupExpiredReservations();

  const schema = z.object({
    fieldId: z.string(),
    date: z.string(),
    time: z.string()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });

  const { fieldId, date, time } = parsed.data;
const username = req.session.user.username;
const isAdmin = req.session.user.role === "admin";

// ===== CONTROLLO CREDITI (OBBLIGATORIO) =====
if (!isAdmin) {
  const userSnap = await db.collection("users").doc(username).get();
  const user = userSnap.exists ? userSnap.data() : {};

  if ((user.credits ?? 0) <= 0) {
    return res.status(400).json({
      error: "NO_CREDITS"
    });
  }
}



// ================= LIMITI PRENOTAZIONE GIORNALIERI =================
if (!isAdmin) {
  const cfgSnap = await db.collection("admin").doc("config").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};

  const maxPerDay = Number(cfg.maxBookingsPerUserPerDay || 1);
  const maxPerWeek = Number(cfg.maxBookingsPerUserPerWeek || 3);
  const maxActive = Number(cfg.maxActiveBookingsPerUser || 1);

  // ===== LIMITE GIORNALIERO =====
  const sameDaySnap = await db
    .collection("reservations")
    .where("date", "==", date)
    .where("user", "==", username)
    .get();

  if (sameDaySnap.size >= maxPerDay) {
    return res.status(400).json({ error: "MAX_PER_DAY_LIMIT" });
  }

  // ===== LIMITE SETTIMANALE =====
  const startOfWeek = new Date(date);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay() + 1);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  const weekSnap = await db
    .collection("reservations")
    .where("user", "==", username)
    .where("date", ">=", startOfWeek.toISOString().slice(0, 10))
    .where("date", "<=", endOfWeek.toISOString().slice(0, 10))
    .get();

  if (weekSnap.size >= maxPerWeek) {
    return res.status(400).json({ error: "MAX_PER_WEEK_LIMIT" });
  }

  // ===== LIMITE PRENOTAZIONI ATTIVE =====
  const today = localISODate();
  const activeSnap = await db
    .collection("reservations")
    .where("user", "==", username)
    .where("date", ">", today)
    .get();

  if (activeSnap.size >= maxActive) {
    return res.status(400).json({ error: "ACTIVE_BOOKING_LIMIT" });
  }
}

// ================= CHIUSURE ORARIE SU PERIODO =================
if (!isAdmin) {
  const snap = await db
    .collection("admin")
    .doc("closedSlots")
    .collection("slots")
    .get();

  const reqMin = minutes(time);


  for (const d of snap.docs) {
    const c = d.data();

    // campo specifico o tutti
    if (c.fieldId !== "*" && c.fieldId !== fieldId) continue;

    // data fuori intervallo
    if (date < c.startDate || date > c.endDate) continue;

   const from = minutes(c.startTime);
const to = minutes(c.endTime);

    if (reqMin >= from && reqMin < to) {
      return res.status(400).json({
        error: "FIELD_CLOSED_TIME",
        reason: c.reason || "Campo chiuso in questo orario"
      });
    }
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

  await snap.ref.delete();
  res.json({ ok: true });
});

/* =================== ADMIN USERS =================== */
router.get("/admin/users", requireAdmin, async (req, res) => {
  const snap = await db.collection("users").get();
  const items = snap.docs.map(d => ({
    username: d.id,
    role: d.data().role || "user",
    credits: d.data().credits ?? 0,
    disabled: !!d.data().disabled
  }));
  res.json({ items });
});

router.put("/admin/users/password", requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  const hash = await bcrypt.hash(newPassword, 10);
  await db.collection("users").doc(username)
    .update({ passwordHash: hash });
  res.json({ ok: true });
});
/* =================== ADMIN CONFIG =================== */
router.put("/admin/config", requireAdmin, async (req, res) => {
  const schema = z.object({
  slotMinutes: z.number().min(15).max(180),
  openRanges: z.array(
    z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/)
    })
  ),
  maxBookingsPerUserPerDay: z.number().min(1).max(10),
  maxBookingsPerUserPerWeek: z.number().min(1).max(20), // 👈 AGGIUNGI
  maxActiveBookingsPerUser: z.number().min(1).max(10)
});



  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "BAD_BODY" });
  }

  await db
    .collection("admin")
    .doc("config")
    .set(parsed.data, { merge: true });

  res.json({ ok: true });
});
/* =================== METEO (PUBBLICO) =================== */
router.get("/weather", async (req, res) => {
  try {
    // Coordinate Senigallia
    const lat = 43.716;
    const lon = 13.217;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&daily=weathercode` +
      `&timezone=Europe/Rome`;

    const r = await fetch(url);
    const data = await r.json();

    res.json(data);
  } catch (e) {
    console.error("Errore meteo", e);
    res.status(500).json({ error: "WEATHER_ERROR" });
  }
});
router.put("/admin/notes", requireAdmin, async (req, res) => {
  const { text } = req.body;
  await db.collection("admin").doc("notes")
    .set({ text: text || "" }, { merge: true });

  res.json({ ok: true });
});
router.put("/admin/fields", requireAdmin, async (req, res) => {
  const { fields } = req.body;
  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: "BAD_FIELDS" });
  }

  await db.collection("admin").doc("fields")
    .set({ fields }, { merge: true });

  res.json({ ok: true });
});
router.put("/admin/gallery", requireAdmin, async (req, res) => {
  const { images } = req.body;
  if (!Array.isArray(images)) {
    return res.status(400).json({ error: "BAD_GALLERY" });
  }

  await db.collection("admin").doc("gallery")
    .set({ images }, { merge: true });

  res.json({ ok: true });
});
router.put("/admin/users/credits", requireAdmin, async (req, res) => {
  const { username, delta } = req.body;
  await db.collection("users").doc(username)
    .update({ credits: FieldValue.increment(Number(delta)) });

  res.json({ ok: true });
});
router.post("/admin/users/rename", requireAdmin, async (req, res) => {
  const { oldUsername, newUsername } = req.body;

  const oldRef = db.collection("users").doc(oldUsername);
  const snap = await oldRef.get();
  if (!snap.exists) return res.status(404).json({ error: "USER_NOT_FOUND" });

  await db.collection("users").doc(newUsername).set(snap.data());
  await oldRef.delete();

  res.json({ ok: true });
});
router.put("/admin/users/status", requireAdmin, async (req, res) => {
  const { username, disabled } = req.body;
  await db.collection("users").doc(username)
    .update({ disabled: !!disabled });

  res.json({ ok: true });
});
router.post("/admin/users/add-credits-all", requireAdmin, async (req, res) => {
  const { amount } = req.body;

  const snap = await db.collection("users").get();
  const batch = db.batch();

  snap.forEach(d => {
    batch.update(d.ref, {
      credits: FieldValue.increment(Number(amount))
    });
  });

  await batch.commit();
  res.json({ updated: snap.size });
});

/* =================== CLOSED SLOTS (CHIUSURE ORARIE) =================== */

// ADMIN: lista chiusure orarie
router.get("/admin/closed-slots", requireAdmin, async (req, res) => {
  const snap = await db
    .collection("admin")
    .doc("closedSlots")
    .collection("slots")
    .orderBy("createdAt", "desc")
    .get();

  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ items });
});

// ADMIN: aggiungi chiusura oraria
router.post("/admin/closed-slots", requireAdmin, async (req, res) => {
  const schema = z.object({
    fieldId: z.string().min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    reason: z.string().optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });

  const data = parsed.data;

  // check range logico
  if (data.startDate > data.endDate) {
    return res.status(400).json({ error: "INVALID_RANGE" });
  }
  if (timeToMinutes(data.startTime) >= timeToMinutes(data.endTime)) {
    return res.status(400).json({ error: "INVALID_TIME_RANGE" });
  }

  await db
    .collection("admin")
    .doc("closedSlots")
    .collection("slots")
    .add({
      ...data,
      createdAt: FieldValue.serverTimestamp()
    });

  res.json({ ok: true });
});

// ADMIN: elimina chiusura oraria
router.delete("/admin/closed-slots/:id", requireAdmin, async (req, res) => {
  await db
    .collection("admin")
    .doc("closedSlots")
    .collection("slots")
    .doc(req.params.id)
    .delete();

  res.json({ ok: true });
});


/* =================== CLOSED DAYS =================== */

// PUBLIC: giorni chiusi
router.get("/public/closed-days", async (req, res) => {
  const snap = await db
    .collection("admin")
    .doc("closedDays")
    .collection("days")
    .get();

  const days = snap.docs.map(d => d.id);
  res.json({ days });
});

// PUBLIC: chiusure orarie
router.get("/public/closed-slots", async (req, res) => {
  const snap = await db
    .collection("admin")
    .doc("closedSlots")
    .collection("slots")
    .get();

  const items = snap.docs.map(d => d.data());
  res.json({ items });
});


// ADMIN: chiudi giorno
router.post("/admin/closed-days", requireAdmin, async (req, res) => {
  const { date, reason } = req.body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "BAD_DATE" });
  }

  await db
    .collection("admin")
    .doc("closedDays")
    .collection("days")
    .doc(date)
    .set({
      reason: reason || "",
      createdAt: FieldValue.serverTimestamp()
    });

  res.json({ ok: true });
});

// ADMIN: riapri giorno
router.delete("/admin/closed-days/:date", requireAdmin, async (req, res) => {
  await db
    .collection("admin")
    .doc("closedDays")
    .collection("days")
    .doc(req.params.date)
    .delete();

  res.json({ ok: true });
});
// ADMIN: chiudi periodo (es. ferie)
router.post("/admin/closed-days/range", requireAdmin, async (req, res) => {
  const { startDate, endDate, reason } = req.body;

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
  ) {
    return res.status(400).json({ error: "BAD_DATE" });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (start > end) {
    return res.status(400).json({ error: "INVALID_RANGE" });
  }

  const batch = db.batch();
  const ref = db.collection("admin").doc("closedDays").collection("days");

  let d = new Date(start);
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    batch.set(ref.doc(iso), {
      reason: reason || "Chiusura",
      createdAt: FieldValue.serverTimestamp()
    });
    d.setDate(d.getDate() + 1);
  }

  await batch.commit();
  res.json({ ok: true });
});

export default router;
