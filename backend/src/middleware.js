import { findUser } from "./auth.js";

export async function requireAuth(req, res, next) {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const user = await findUser(username);
  if (!user || user.disabled) {
    return res.status(401).json({ error: "NOT_AUTHENTICATED" });
  }

  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "ADMIN_ONLY" });
  }
  next();
}
