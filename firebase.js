const admin = require('firebase-admin');

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    // Clean up the string in case Render added accidental outer quotes
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"');
    }
    serviceAccount = JSON.parse(raw);
    console.log('✅ [Firebase] Loaded credentials from Environment Variable.');
  } catch (e) {
    console.error('❌ [Firebase] CRITICAL: FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    console.error('❌ [Firebase] Detail:', e.message);
    console.error('❌ [Firebase] Please check your Render Environment Variables.');
    process.exit(1); // Force crash with a clear message so you know why
  }
} else {
  console.error('❌ [Firebase] CRITICAL: FIREBASE_SERVICE_ACCOUNT environment variable is MISSING.');
  console.error('❌ [Firebase] Go to Render Dashboard -> Environment -> Add "FIREBASE_SERVICE_ACCOUNT"');
  process.exit(1);
}

// Initialize Firebase
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ [Firebase] Admin Initialized Successfully.');
} catch (e) {
  console.error('❌ [Firebase] Initialization failed:', e.message);
  process.exit(1);
}

module.exports = { 
  admin, 
  db: admin.firestore(), 
  auth: admin.auth() 
};
