import admin from "firebase-admin";

// Read service account from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_NEW);

const newApp = admin.initializeApp(
  {
    credential: admin.credential.cert(serviceAccount),
  },
  "campusBikeRental"
);

export const dbNew = newApp.firestore();
export { newApp as adminNew };