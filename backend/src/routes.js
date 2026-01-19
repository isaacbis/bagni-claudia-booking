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
  timeRanges: cfg.timeRanges || [
    { start: "09:00", end: "13:40" },
    { start: "16:00", end: "20:00" }
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

// ===== LIMITE PRENOTAZIONE: MAX 7 GIORNI AVANTI =====
const today = localISODate();
const maxDate = new Date(today);
maxDate.setDate(maxDate.getDate() + 7);
const maxISO = maxDate.toISOString().slice(0, 10);

if (date > maxISO) {
  return res.status(403).json({ error: "MAX_7_DAYS_AHEAD" });
}

  // ===== APPLICA LIMITI PRENOTAZIONE =====
  if (!isAdmin) {
    const cfgSnap = await db.collection("admin").doc("config").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};

    const maxPerDay = Number(cfg.maxBookingsPerUserPerDay || 1);
    const maxActive = Number(cfg.maxActiveBookingsPerUser || 1);

    // prenotazioni attive totali
    const activeSnap = await db
      .collection("reservations")
      .where("user", "==", username)
      .get();

    if (activeSnap.size >= maxActive) {
      return res.status(403).json({ error: "ACTIVE_BOOKING_LIMIT" });
    }

    // prenotazioni per quel giorno
    const daySnap = await db
      .collection("reservations")
      .where("user", "==", username)
      .where("date", "==", date)
      .get();

    if (daySnap.size >= maxPerDay) {
      return res.status(403).json({ error: "MAX_PER_DAY_LIMIT" });
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
    slotMinutes: z.coerce.number().min(15).max(180),
    timeRanges: z.array(
      z.object({
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/)
      })
    ).min(1),
    maxBookingsPerUserPerDay: z.coerce.number().min(1).max(10),
    maxActiveBookingsPerUser: z.coerce.number().min(1).max(10)
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


// =================== ADMIN SET CREDITI A TUTTI ===================
router.post("/admin/users/set-credits-all", requireAdmin, async (req, res) => {
  const { credits } = req.body;

  if (typeof credits !== "number" || credits < 0) {
    return res.status(400).json({ error: "INVALID_CREDITS" });
  }

  const snap = await db.collection("users").get();
  const batch = db.batch();

  snap.forEach(doc => {
    batch.update(doc.ref, { credits });
  });

  await batch.commit();

  res.json({ ok: true, updated: snap.size });
});


export default router;