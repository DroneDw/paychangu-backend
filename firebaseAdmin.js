import admin from "firebase-admin";

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error("❌ CRITICAL MISSING ENV VARS:", missing);
  console.error("Add these in Render Dashboard → Environment");
  process.exit(1);
}

if (!admin.apps.length) {
  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase initialized");
  } catch (err) {
    console.error("❌ Firebase init failed:", err.message);
    process.exit(1);
  }
}

export const db = admin.firestore();
export { admin };