const admin = require('firebase-admin');

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"');
    }
    serviceAccount = JSON.parse(raw);
    console.log('✅ [Firebase] Loaded credentials from Environment Variable.');
  } catch (e) {
    console.error('❌ [Firebase] CRITICAL: FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    process.exit(1);
  }
} else {
  console.error('❌ [Firebase] CRITICAL: FIREBASE_SERVICE_ACCOUNT environment variable is MISSING.');
  process.exit(1);
}

// Initialize Firebase WITH STORAGE BUCKET
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'bot-create-9cebb.firebasestorage.app' // ✅ THIS WAS MISSING!
  });
  console.log('✅ [Firebase] Admin & Storage Initialized Successfully.');
} catch (e) {
  console.error('❌ [Firebase] Initialization failed:', e.message);
  process.exit(1);
}

module.exports = { 
  admin, 
  db: admin.firestore(), 
  auth: admin.auth()
};
