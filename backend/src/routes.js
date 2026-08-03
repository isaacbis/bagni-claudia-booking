import express from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, FieldValue } from "./db.js";

const router = express.Router();
const ROME_TZ = "Europe/Rome";
const CLEANUP_COOLDOWN_MS = 60_000;
const CANCEL_GRACE_MINUTES = 5;
const MAX_ADVANCE_DAYS = 7;
let lastCleanup = 0;

const usernameSchema = z.string().trim().min(1).max(60).refine(v => !v.includes("/"));
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function getRomeNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function realRomeISODate() {
  const now = getRomeNowParts();
  return `${now.year}-${String(now.month).padStart(2, "0")}-${String(now.day).padStart(2, "0")}`;
}

function addDaysISO(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isValidISODate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function compareReservationWithNow(date, time) {
  const now = getRomeNowParts();
  const nowKey = `${realRomeISODate()}T${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  return `${date}T${time}`.localeCompare(nowKey);
}

function isBeforeBookingCutoff() {
  const now = getRomeNowParts();
  return now.hour * 60 + now.minute < 8 * 60 + 30;
}

function normalizeConfig(data = {}) {
  return {
    slotMinutes: Number(data.slotMinutes || 45),
    timeRanges: Array.isArray(data.timeRanges) && data.timeRanges.length
      ? data.timeRanges
      : [{ start: "09:00", end: "13:40" }, { start: "16:00", end: "20:00" }],
    maxBookingsPerUserPerDay: Number(data.maxBookingsPerUserPerDay || 1),
    maxActiveBookingsPerUser: Number(data.maxActiveBookingsPerUser || 1)
  };
}

function allowedTimes(config) {
  const result = new Set();
  for (const range of config.timeRanges) {
    const start = timeToMinutes(range.start);
    const end = timeToMinutes(range.end);
    for (let minute = start; minute + config.slotMinutes <= end; minute += config.slotMinutes) {
      result.add(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
    }
  }
  return result;
}

async function loadPublicConfiguration() {
  const [configSnap, fieldsSnap, notesSnap, gallerySnap] = await Promise.all([
    db.collection("admin").doc("config").get(),
    db.collection("admin").doc("fields").get(),
    db.collection("admin").doc("notes").get(),
    db.collection("admin").doc("gallery").get()
  ]);
  const config = normalizeConfig(configSnap.exists ? configSnap.data() : {});
  return {
    ...config,
    fields: fieldsSnap.exists ? fieldsSnap.data().fields || [] : [],
    notesText: notesSnap.exists ? notesSnap.data().text || "" : "",
    gallery: gallerySnap.exists ? gallerySnap.data().images || [] : []
  };
}

async function requireAuth(req, res, next) {
  try {
    const username = req.session?.user?.username;
    if (!username) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    const ref = db.collection("users").doc(username);
    const snap = await ref.get();
    if (!snap.exists || snap.data().disabled) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: snap.exists ? "USER_DISABLED" : "NOT_AUTHENTICATED" });
    }
    const user = snap.data();
    const credits = Number(user.credits);
    if (!Number.isFinite(credits) || credits < 0) await ref.update({ credits: 0 });
    req.authUser = { username, role: user.role || "user" };
    req.session.user.role = req.authUser.role;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(req, res, next) {
  requireAuth(req, res, error => {
    if (error) return next(error);
    if (req.authUser?.role !== "admin") return res.status(403).json({ error: "NOT_AUTHORIZED" });
    next();
  });
}

async function cleanupExpiredReservations() {
  const nowMs = Date.now();
  if (nowMs - lastCleanup < CLEANUP_COOLDOWN_MS) return;
  lastCleanup = nowMs;
  const configSnap = await db.collection("admin").doc("config").get();
  const config = normalizeConfig(configSnap.exists ? configSnap.data() : {});
  const today = realRomeISODate();
  const now = getRomeNowParts();
  const currentMinutes = now.hour * 60 + now.minute;
  const snap = await db.collection("reservations").where("date", "<=", today).get();
  if (snap.empty) return;
  const batch = db.batch();
  let deleted = 0;
  snap.forEach(doc => {
    const reservation = doc.data();
    const expired = reservation.date < today || (
      reservation.date === today && timeToMinutes(reservation.time) + config.slotMinutes <= currentMinutes
    );
    if (expired) {
      batch.delete(doc.ref);
      deleted += 1;
    }
  });
  if (deleted) await batch.commit();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ username: usernameSchema, password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });
    const { username, password } = parsed.data;
    const snap = await db.collection("users").doc(username).get();
    if (!snap.exists) return res.status(401).json({ error: "INVALID_LOGIN" });
    const user = snap.data();
    if (user.disabled) return res.status(403).json({ error: "USER_DISABLED" });
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "INVALID_LOGIN" });
    }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.user = { username, role: user.role || "user" };
      req.session.save(saveError => saveError ? next(saveError) : res.json({ ok: true }));
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie(process.env.SESSION_COOKIE_NAME || "bagniClaudiaSid");
    res.json({ ok: true });
  });
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const snap = await db.collection("users").doc(req.authUser.username).get();
    const user = snap.data();
    res.json({
      username: req.authUser.username,
      role: req.authUser.role,
      credits: Math.max(0, Number(user.credits) || 0),
      disabled: false
    });
  } catch (error) {
    next(error);
  }
});

router.get("/public/config", async (_req, res, next) => {
  try {
    res.json(await loadPublicConfiguration());
  } catch (error) {
    next(error);
  }
});

router.get("/reservations", requireAuth, async (req, res, next) => {
  try {
    await cleanupExpiredReservations();
    const date = String(req.query.date || "");
    if (!isValidISODate(date)) return res.status(400).json({ error: "BAD_DATE" });
    const snap = await db.collection("reservations").where("date", "==", date).get();
    const isAdmin = req.authUser.role === "admin";
    const items = snap.docs.map(doc => {
      const data = doc.data();
      const item = { id: doc.id, fieldId: data.fieldId, date: data.date, time: data.time };
      if (isAdmin || data.user === req.authUser.username) item.user = data.user;
      return item;
    }).sort((a, b) => a.time.localeCompare(b.time) || a.fieldId.localeCompare(b.fieldId));
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

router.post("/reservations", requireAuth, async (req, res, next) => {
  try {
    await cleanupExpiredReservations();
    const parsed = z.object({
      fieldId: z.string().trim().min(1).max(80).refine(v => !v.includes("/")),
      date: dateSchema,
      time: timeSchema
    }).safeParse(req.body);
    if (!parsed.success || !isValidISODate(parsed.data?.date)) {
      return res.status(400).json({ error: "BAD_BODY" });
    }
    const { fieldId, date, time } = parsed.data;
    const today = realRomeISODate();
    if (date < today) return res.status(403).json({ error: "PAST_DATE" });
    if (date > addDaysISO(today, MAX_ADVANCE_DAYS)) return res.status(403).json({ error: "MAX_7_DAYS_AHEAD" });
    if (date === today && isBeforeBookingCutoff()) {
      return res.status(403).json({ error: "CURRENT_DAY_LOCKED_UNTIL_0830" });
    }
    if (compareReservationWithNow(date, time) <= 0) return res.status(403).json({ error: "PAST_TIME" });

    const publicConfig = await loadPublicConfiguration();
    if (!publicConfig.fields.some(field => String(field.id) === fieldId)) {
      return res.status(400).json({ error: "INVALID_FIELD" });
    }
    if (!allowedTimes(publicConfig).has(time)) return res.status(400).json({ error: "INVALID_TIME" });

    const username = req.authUser.username;
    const isAdmin = req.authUser.role === "admin";
    const reservationRef = db.collection("reservations").doc(`${fieldId}_${date}_${time}`);
    const userRef = db.collection("users").doc(username);
    const activeQuery = db.collection("reservations").where("user", "==", username);
    const dayQuery = activeQuery.where("date", "==", date);

    try {
      await db.runTransaction(async transaction => {
        const reads = isAdmin
          ? [transaction.get(reservationRef)]
          : [
              transaction.get(reservationRef),
              transaction.get(userRef),
              transaction.get(activeQuery),
              transaction.get(dayQuery)
            ];
        const [slotSnap, userSnap, activeSnap, daySnap] = await Promise.all(reads);
        if (slotSnap.exists) throw new Error("SLOT_TAKEN");
        if (!isAdmin) {
          if (!userSnap.exists || userSnap.data().disabled) throw new Error("USER_NOT_FOUND");
          const credits = Number(userSnap.data().credits);
          if (!Number.isInteger(credits) || credits < 1) throw new Error("NO_CREDITS");
          if (activeSnap.size >= publicConfig.maxActiveBookingsPerUser) throw new Error("ACTIVE_BOOKING_LIMIT");
          if (daySnap.size >= publicConfig.maxBookingsPerUserPerDay) throw new Error("MAX_PER_DAY_LIMIT");
          transaction.update(userRef, { credits: credits - 1 });
        }
        transaction.create(reservationRef, {
          fieldId,
          date,
          time,
          user: username,
          charged: !isAdmin,
          createdAt: FieldValue.serverTimestamp()
        });
      });
    } catch (error) {
      const statuses = {
        SLOT_TAKEN: 409,
        NO_CREDITS: 403,
        ACTIVE_BOOKING_LIMIT: 403,
        MAX_PER_DAY_LIMIT: 403,
        USER_NOT_FOUND: 404
      };
      if (statuses[error.message]) return res.status(statuses[error.message]).json({ error: error.message });
      throw error;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete("/reservations/:id", requireAuth, async (req, res, next) => {
  try {
    const reservationRef = db.collection("reservations").doc(req.params.id);
    try {
      await db.runTransaction(async transaction => {
        const reservationSnap = await transaction.get(reservationRef);
        if (!reservationSnap.exists) return;
        const reservation = reservationSnap.data();
        const isAdmin = req.authUser.role === "admin";
        if (!isAdmin && reservation.user !== req.authUser.username) throw new Error("NOT_ALLOWED");
        if (compareReservationWithNow(reservation.date, reservation.time) <= 0) {
          throw new Error("PAST_RESERVATION_CANNOT_BE_DELETED");
        }
        const today = realRomeISODate();
        const now = getRomeNowParts();
        const createdAtMs = reservation.createdAt?.toMillis?.() || reservation.createdAt?._seconds * 1000 || 0;
        const inGracePeriod = createdAtMs > 0 && (Date.now() - createdAtMs) / 60000 <= CANCEL_GRACE_MINUTES;
        if (!isAdmin && reservation.date === today && !inGracePeriod) {
          const minutesUntilStart = timeToMinutes(reservation.time) - (now.hour * 60 + now.minute);
          if (minutesUntilStart <= 60) throw new Error("CANNOT_CANCEL_WITHIN_1_HOUR");
        }

        const userRef = reservation.user ? db.collection("users").doc(reservation.user) : null;
        const userSnap = userRef ? await transaction.get(userRef) : null;
        const shouldRefund = reservation.charged === true || (
          reservation.charged === undefined && userSnap?.exists && (userSnap.data().role || "user") !== "admin"
        );
        transaction.delete(reservationRef);
        if (shouldRefund && userSnap?.exists) {
          const credits = Math.max(0, Number(userSnap.data().credits) || 0);
          transaction.update(userRef, { credits: credits + 1 });
        }
      });
    } catch (error) {
      const statuses = {
        NOT_ALLOWED: 403,
        PAST_RESERVATION_CANNOT_BE_DELETED: 403,
        CANNOT_CANCEL_WITHIN_1_HOUR: 403
      };
      if (statuses[error.message]) return res.status(statuses[error.message]).json({ error: error.message });
      throw error;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/users", requireAdmin, async (_req, res, next) => {
  try {
    const snap = await db.collection("users").get();
    const invalidCreditDocs = snap.docs.filter(doc => {
      const credits = Number(doc.data().credits);
      return !Number.isFinite(credits) || credits < 0;
    });
    for (let index = 0; index < invalidCreditDocs.length; index += 450) {
      const batch = db.batch();
      invalidCreditDocs.slice(index, index + 450).forEach(doc => batch.update(doc.ref, { credits: 0 }));
      await batch.commit();
    }
    res.json({ items: snap.docs.map(doc => ({
      username: doc.id,
      role: doc.data().role || "user",
      credits: Math.max(0, Number(doc.data().credits) || 0),
      disabled: !!doc.data().disabled
    })).sort((a, b) => a.username.localeCompare(b.username, "it")) });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/users/password", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ username: usernameSchema, newPassword: z.string().min(8).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PASSWORD" });
    await db.collection("users").doc(parsed.data.username).update({
      passwordHash: await bcrypt.hash(parsed.data.newPassword, 12)
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/config", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({
      slotMinutes: z.coerce.number().int().min(15).max(180),
      timeRanges: z.array(z.object({ start: timeSchema, end: timeSchema })).min(1).max(4),
      maxBookingsPerUserPerDay: z.coerce.number().int().min(1).max(10),
      maxActiveBookingsPerUser: z.coerce.number().int().min(1).max(10)
    }).refine(value => value.timeRanges.every(range => timeToMinutes(range.start) < timeToMinutes(range.end)), {
      message: "INVALID_TIME_RANGE"
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });
    await db.collection("admin").doc("config").set(parsed.data, { merge: true });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/weather", async (_req, res, next) => {
  try {
    const response = await fetch("https://api.open-meteo.com/v1/forecast?latitude=43.716&longitude=13.217&daily=weathercode&timezone=Europe%2FRome");
    if (!response.ok) throw new Error(`WEATHER_${response.status}`);
    res.json(await response.json());
  } catch (error) {
    next(error);
  }
});

router.put("/admin/notes", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().max(5000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });
    await db.collection("admin").doc("notes").set({ text: parsed.data.text }, { merge: true });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/fields", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ fields: z.array(z.object({
      id: z.string().trim().min(1).max(80).refine(v => !v.includes("/")),
      name: z.string().trim().min(1).max(100)
    })).max(30) }).refine(value => new Set(value.fields.map(field => field.id)).size === value.fields.length).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_FIELDS" });
    await db.collection("admin").doc("fields").set(parsed.data, { merge: true });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/gallery", requireAdmin, async (req, res, next) => {
  try {
    const httpUrl = z.string().url().refine(value => /^https?:\/\//i.test(value));
    const parsed = z.object({ images: z.array(z.object({
      url: httpUrl,
      caption: z.string().max(120).default(""),
      link: httpUrl
    })).max(10) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_GALLERY" });
    await db.collection("admin").doc("gallery").set(parsed.data, { merge: true });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/users/credits", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ username: usernameSchema, credits: z.coerce.number().int().min(0).max(1_000_000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_CREDITS" });
    await db.collection("users").doc(parsed.data.username).update({ credits: parsed.data.credits });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/users/rename", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ oldUsername: usernameSchema, newUsername: usernameSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });
    const { oldUsername, newUsername } = parsed.data;
    if (oldUsername === newUsername) return res.status(400).json({ error: "SAME_USERNAME" });
    const oldRef = db.collection("users").doc(oldUsername);
    const newRef = db.collection("users").doc(newUsername);
    try {
      await db.runTransaction(async transaction => {
        const [oldSnap, newSnap] = await Promise.all([transaction.get(oldRef), transaction.get(newRef)]);
        if (!oldSnap.exists) throw new Error("USER_NOT_FOUND");
        if (newSnap.exists) throw new Error("USERNAME_ALREADY_EXISTS");
        transaction.create(newRef, oldSnap.data());
        transaction.delete(oldRef);
      });
    } catch (error) {
      if (error.message === "USER_NOT_FOUND") return res.status(404).json({ error: error.message });
      if (error.message === "USERNAME_ALREADY_EXISTS") return res.status(409).json({ error: error.message });
      throw error;
    }
    const reservations = await db.collection("reservations").where("user", "==", oldUsername).get();
    for (let index = 0; index < reservations.docs.length; index += 450) {
      const batch = db.batch();
      reservations.docs.slice(index, index + 450).forEach(doc => batch.update(doc.ref, { user: newUsername }));
      await batch.commit();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/admin/users/status", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ username: usernameSchema, disabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "BAD_BODY" });
    if (parsed.data.username === req.authUser.username && parsed.data.disabled) {
      return res.status(400).json({ error: "CANNOT_DISABLE_SELF" });
    }
    await db.collection("users").doc(parsed.data.username).update({ disabled: parsed.data.disabled });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/users/add-credits-all", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ amount: z.coerce.number().int().min(0).max(1_000_000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_CREDITS" });
    const snap = await db.collection("users").get();
    for (let index = 0; index < snap.docs.length; index += 450) {
      const batch = db.batch();
      snap.docs.slice(index, index + 450).forEach(doc => {
        const credits = Math.max(0, Number(doc.data().credits) || 0);
        batch.update(doc.ref, { credits: credits + parsed.data.amount });
      });
      await batch.commit();
    }
    res.json({ ok: true, updated: snap.size });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/users/set-credits-all", requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ credits: z.coerce.number().int().min(0).max(1_000_000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_CREDITS" });
    const snap = await db.collection("users").get();
    for (let index = 0; index < snap.docs.length; index += 450) {
      const batch = db.batch();
      snap.docs.slice(index, index + 450).forEach(doc => batch.update(doc.ref, { credits: parsed.data.credits }));
      await batch.commit();
    }
    res.json({ ok: true, updated: snap.size });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  console.error("API error:", error);
  if (error?.code === 5) return res.status(404).json({ error: "NOT_FOUND" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
});

export default router;
