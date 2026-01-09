import "dotenv/config";
import bcrypt from "bcrypt";
import { db } from "../src/db.js";

const SALT_ROUNDS = 10;

async function run() {
  const snap = await db.collection("users").get();
  let migrated = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    // se già migrato, skip
    if (data.passwordHash) continue;

    // se non ha password in chiaro, skip
    if (!data.password) {
      console.log("SKIP (no password):", doc.id);
      continue;
    }

    const hash = await bcrypt.hash(String(data.password), SALT_ROUNDS);

    await doc.ref.update({
      passwordHash: hash,
    });

    migrated++;
    console.log("Migrato:", doc.id);
  }

  console.log("✅ Migrazione completata. Utenti migrati:", migrated);
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Errore migrazione:", err);
  process.exit(1);
});
