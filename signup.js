// ============================================
// SIGNUP LOGIC
// ============================================

import { auth, db } from "./firebase-config.js";
import { createUserWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.getElementById("signup-form");
const errorBox = document.getElementById("error-box");

// Runs when the form is submitted
form.addEventListener("submit", async (event) => {
  event.preventDefault(); // stops the page from reloading (default form behavior)

  // Grab whatever the user typed into each field
  const username = document.getElementById("username").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    // Step 1: create the account in Firebase Authentication (handles email + password)
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // Step 2: attach the username to their Auth profile (so user.displayName works later)
    await updateProfile(user, { displayName: username });

    // Step 3: save extra profile info in Firestore, in a "users" collection.
    // We use the user's unique ID (uid) as the document ID, so it's easy to look up later.
    await setDoc(doc(db, "users", user.uid), {
      username: username,
      email: email,
      createdAt: serverTimestamp() // Firebase fills this in with the current server time
    });

    // Step 4: success! Send them to the homepage.
    window.location.href = "index.html";

  } catch (error) {
    // Firebase gives error codes like "auth/email-already-in-use" — we turn a few common
    // ones into friendlier messages. Anything else falls back to Firebase's own message.
    let message = error.message;
    if (error.code === "auth/email-already-in-use") {
      message = "That email is already registered. Try logging in instead.";
    } else if (error.code === "auth/weak-password") {
      message = "Password should be at least 6 characters.";
    } else if (error.code === "auth/invalid-email") {
      message = "That email address doesn't look valid.";
    }

    errorBox.textContent = message;
    errorBox.style.display = "block";
  }
});
