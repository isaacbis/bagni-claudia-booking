import bcrypt from "bcrypt";
import { db } from "./db.js";

export async function findUser(username) {
  const snap = await db.collection("users").doc(username).get();
  if (!snap.exists) return null;
  return { username: snap.id, ...snap.data() };
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
