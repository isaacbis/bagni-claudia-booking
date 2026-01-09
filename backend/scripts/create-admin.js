import "dotenv/config";
import { db } from "../src/db.js";

async function run() {
  const username = "admin";          // 👈 cambia se vuoi
  const password = "admin123";       // 👈 CAMBIALA DOPO IL PRIMO LOGIN
  const role = "admin";

  const ref = db.collection("users").doc(username);
  const snap = await ref.get();

  if (snap.exists) {
    console.log("❌ Utente admin già esistente:", username);
    process.exit(0);
  }

  await ref.set({
    password,          // ⚠️ per ora in chiaro (step sicurezza dopo)
    role,
    credits: 9999,     // admin illimitato
    disabled: false,
    createdAt: new Date()
  });

  console.log("✅ Admin creato con successo:");
  console.log({
    username,
    password,
    role
  });

  process.exit(0);
}

run().catch(err => {
  console.error("Errore creazione admin:", err);
  process.exit(1);
});
