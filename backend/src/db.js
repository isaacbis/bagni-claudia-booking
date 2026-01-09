import admin from "firebase-admin";

/**
 * Inizializzazione Firebase Admin
 * Funziona sia:
 * - in locale (se hai GOOGLE_APPLICATION_CREDENTIALS settata)
 * - su Render (con GOOGLE_APPLICATION_CREDENTIALS_JSON)
 */

if (!admin.apps.length) {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    // Caso Render: credenziali da ENV
    const serviceAccount = JSON.parse(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    // Caso locale: usa le credenziali di default
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
}

// Firestore
export const db = admin.firestore();

// Timestamp helper
export const FieldValue = admin.firestore.FieldValue;
