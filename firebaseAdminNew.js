import admin from "firebase-admin";
import { readFileSync } from "fs";

// Read from secret file (Render stores secret files in /etc/secrets/)
const serviceAccount = JSON.parse(
  readFileSync("/etc/secrets/serviceAccountKeyNew.json", "utf8")
);

const newApp = admin.initializeApp(
  {
    credential: admin.credential.cert(serviceAccount),
  },
  "campusBikeRental"
);

export const dbNew = newApp.firestore();
export { newApp as adminNew };