const admin = require('firebase-admin');
const path = require('path');

// Load Firebase Service Account credentials
const serviceAccountPath = process.env.FIREBASE_CREDENTIALS_PATH || './serviceAccountKey.json';
const serviceAccount = require(path.resolve(serviceAccountPath));

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Firestore + Authentication
const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
