import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import session from "express-session";

import routes from "./src/routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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
        "style-src": ["'self'"],
        "connect-src": ["'self'"],
        "upgrade-insecure-requests": [],
      },
    },
  })
);

/* ======================================================
   PARSER
   ====================================================== */
app.use(express.json());
app.use(cookieParser());

/* ======================================================
   SESSIONI (ANTI-LOGOUT + RENDER FRIENDLY)
   ====================================================== */
app.use(
  session({
    name: process.env.SESSION_COOKIE_NAME || "tommi38sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // 🔁 rinnova ad ogni richiesta
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8, // ⏱️ 8 ORE
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
app.use(express.static(frontendPath));

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
  res.sendFile(path.join(frontendPath, "index.html"));
});

/* ======================================================
   START SERVER
   ====================================================== */
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log("✅ Server Tommi38 avviato sulla porta", PORT);
});
