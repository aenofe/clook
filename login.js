// ============================================
// LOGIN LOGIC
// ============================================

import { auth } from "./firebase-config.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const form = document.getElementById("login-form");
const errorBox = document.getElementById("error-box");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.href = "index.html"; // success -> go home
  } catch (error) {
    let message = "Something went wrong. Please try again.";
    if (error.code === "auth/invalid-credential" || error.code === "auth/wrong-password" || error.code === "auth/user-not-found") {
      message = "Incorrect email or password.";
    } else if (error.code === "auth/invalid-email") {
      message = "That email address doesn't look valid.";
    }

    errorBox.textContent = message;
    errorBox.style.display = "block";
  }
});
