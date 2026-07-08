// ============================================
// GLOBAL NAVBAR & AUTH STATE LOGIC
// ============================================

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const navbarRight = document.getElementById("navbar-right");

// Standard gray-and-white guest profile picture vector backup
const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23cccccc'><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5-4-8-4z'/></svg>";

onAuthStateChanged(auth, (user) => {
  if (user) {
    // Don't bother showing a "New Post" link pointing at the page you're
    // already standing on.
    const onCreatePostPage = window.location.pathname.endsWith("create-post.html");

    // Set up a real-time snapshot observer on the user's account document
    onSnapshot(doc(db, "users", user.uid), (docSnap) => {
      const userData = docSnap.exists() ? docSnap.data() : {};
      const avatarUrl = userData.pfpUrl || DEFAULT_AVATAR;
      const displayName = user.displayName || user.email.split('@')[0];

      if (navbarRight) {
        navbarRight.innerHTML = `
          ${onCreatePostPage ? "" : `<a href="create-post.html" class="btn btn-ghost">New Post</a>`}
          <a href="profile.html?uid=${user.uid}" class="nav-profile-link" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit;">
            <img src="${avatarUrl}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-color, #ccc);" />
            <span class="nav-username" style="font-weight: 500;">u/${displayName}</span>
          </a>
          <button id="logout-btn" class="btn btn-ghost">Log out</button>
        `;

        // Attach logout event handle immediately after injecting markup
        document.getElementById("logout-btn").addEventListener("click", () => {
          auth.signOut().then(() => {
            window.location.href = "index.html";
          });
        });
      }
    });
  } else {
    if (navbarRight) {
      navbarRight.innerHTML = `
        <a href="login.html" class="btn btn-ghost">Log in</a>
        <a href="signup.html" class="btn btn-primary">Sign up</a>
      `;
    }
  }
});