import admin from "firebase-admin";
import fs from "fs";

// Read from Secret File (Render mounts these to /etc/secrets/ or root)
const serviceAccountPath = "./mybalaka-7830b-firebase-adminsdk-fbsvc-bc85ef4eff.json";

let serviceAccount;

try {
  const fileContent = fs.readFileSync(serviceAccountPath, "utf8");
  serviceAccount = JSON.parse(fileContent);
  console.log("✅ Loaded Firebase credentials from file");
} catch (err) {
  console.error("❌ Failed to read Firebase JSON file:", err.message);
  console.error("Make sure the file is uploaded in Secret Files section");
  process.exit(1);
}

if (!admin.apps.length) {
  try {
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