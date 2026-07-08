// ============================================
// FIREBASE SETUP
// This file connects our website to YOUR Firebase project.
// Every other JS file we write will import { auth, db } from here.
// ============================================

// We import Firebase directly from Google's CDN (gstatic) as ES modules.
// This means no npm install, no build tools needed — just works in the browser.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Your project's config (safe to be public - security is handled by Firestore rules, not by hiding this)
const firebaseConfig = {
  apiKey: "AIzaSyC4K9QxyTKL5GbfhXO6VJZfeFQyFHn3_pM",
  authDomain: "clook-95050.firebaseapp.com",
  projectId: "clook-95050",
  storageBucket: "clook-95050.firebasestorage.app",
  messagingSenderId: "766367210281",
  appId: "1:766367210281:web:cf74fc4c298594f1d07538",
  measurementId: "G-PC4WLF5C54"
};

// Initialize the connection to your Firebase project
const app = initializeApp(firebaseConfig);

// auth = handles sign up / login / logout
// db   = handles reading and writing posts, comments, topics
export const auth = getAuth(app);
export const db = getFirestore(app);

console.log("✅ Firebase connected:", app.name);
