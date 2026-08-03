import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import session from "express-session";

import routes from "./src/routes.js";
import { db } from "./src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET deve essere impostata");
}

class FirestoreSessionStore extends session.Store {
  constructor() {
    super();
    this.collection = db.collection("sessions");
  }

  get(sessionId, callback) {
    this.collection.doc(sessionId).get()
      .then(snap => {
        if (!snap.exists) return callback(null, null);
        const data = snap.data();
        if (data.expiresAt?.toDate?.() <= new Date()) {
          return snap.ref.delete().then(() => callback(null, null));
        }
        callback(null, JSON.parse(data.session));
      })
      .catch(callback);
  }

  set(sessionId, sessionData, callback = () => {}) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.collection.doc(sessionId).set({
      session: JSON.stringify(sessionData),
      expiresAt,
      updatedAt: new Date()
    }).then(() => callback()).catch(callback);
  }

  destroy(sessionId, callback = () => {}) {
    this.collection.doc(sessionId).delete().then(() => callback()).catch(callback);
  }

  touch(sessionId, sessionData, callback = () => {}) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.collection.doc(sessionId).set({ expiresAt, updatedAt: new Date() }, { merge: true })
      .then(() => callback())
      .catch(callback);
  }
}

/* ======================================================
   TRUST PROXY (necessario su Render)
   ====================================================== */
app.set("trust proxy", 1);

/* ======================================================
   SECURITY HEADERS (Helmet)
   ====================================================== */
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'self'"],
        "img-src": ["'self'", "data:", "https:"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "connect-src": ["'self'", "https://api.open-meteo.com"],
        "upgrade-insecure-requests": [],
      },
    },
  })
);
/* ======================================================
   PARSER
   ====================================================== */
app.use(express.json({ limit: "250kb" }));
app.use(cookieParser());

/* ======================================================
   SESSIONI (ANTI-LOGOUT + RENDER FRIENDLY)
   ====================================================== */
app.use(
  session({
    name: process.env.SESSION_COOKIE_NAME || "bagniClaudiaSid",
    secret: process.env.SESSION_SECRET,
    store: new FirestoreSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

/* ======================================================
   API ROUTES
   ====================================================== */
app.use("/api", routes);

/* ======================================================
   FRONTEND STATIC (SPA)
   ====================================================== */
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath, {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith("service-worker.js") || filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

/* ======================================================
   HEALTH CHECK (KEEP-ALIVE RENDER)
   ====================================================== */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ======================================================
   SPA FALLBACK
   ====================================================== */
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("Server error:", error);
  res.status(500).json({ error: "INTERNAL_ERROR" });
});

/* ======================================================
   START SERVER
   ====================================================== */
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log("✅ Server Bagni Claudia avviato sulla porta", PORT);
});
