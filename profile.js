// ============================================
// PROFILE PAGE LOGIC
// Shows one user's info (username, joined date, post/comment counts)
// plus a live list of every post they've made.
// ============================================

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  onSnapshot,
  getCountFromServer,
  increment,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Get the user's ID from the URL, e.g. profile.html?uid=abc123 ----
const params = new URLSearchParams(window.location.search);
const uid = params.get("uid");

const profileHeader = document.getElementById("profile-header");
const profilePosts = document.getElementById("profile-posts");
const postsSectionHeading = document.getElementById("posts-section-heading");

// Who's actually logged in right now, viewing this page. Compared against
// `uid` (whose profile this IS) to decide "is this MY OWN profile?" - only
// then do the Archived/Saved tabs make sense, since nobody else should be
// able to browse someone else's archived or saved posts.
let loggedInUid = null;

// Which tab is currently selected on your OWN profile. Only ever matters
// when loggedInUid === uid; ignored otherwise.
let activeTab = "posts";

// Every post by this user, archived or not - onSnapshot keeps this in sync
// in real time. We filter it down to whichever tab is active whenever we
// render, the same in-memory-filtering pattern feed.js uses for search.
let latestUserPosts = [];

// The saved-posts subcollection (users/{uid}/savedPosts) only stores a
// postId and a timestamp - not the post's actual title/body/etc. So once we
// know WHICH posts are saved, we still have to go fetch each one's real
// content separately. savedPostsResolved holds that fully "hydrated" list.
let savedPostsResolved = [];
let savedPostsSubscribed = false; // guards against subscribing more than once

// This logged-in visitor's votes across every post they've voted on -
// same map + collectionGroup pattern as feed.js. Needed here too since your
// OWN posts (and anyone else's, via their profile) show the same vote
// buttons as the feed.
let myVotes = new Map();
let unsubscribeMyVotes = null;

// loadProfile() and loadUserPosts() both start at the same time, but they
// finish at different speeds (one waits on a couple of network calls, the
// other is a fast realtime listener). Whichever one knows the post count
// first stores it here; updatePostCountDisplay() paints it onto the page
// ONLY if the count is known AND the element already exists in the DOM -
// and both functions call it, so whichever finishes second is the one that
// actually makes the number appear.
let latestPostCount = null;

function updatePostCountDisplay() {
  const postCountEl = document.getElementById("profile-post-count");
  if (postCountEl && latestPostCount !== null) {
    postCountEl.textContent = latestPostCount;
  }
}

// ---- Shows a floating "Support" button, pinned to the page's top-right
// corner, ONLY when you're looking at your own profile - nobody else's
// profile is the right place to be filing feedback about your own account. ----
function renderSupportButton() {
  const existing = document.getElementById("support-btn");
  const isOwnProfile = loggedInUid === uid;

  if (!isOwnProfile) {
    if (existing) existing.remove();
    return;
  }

  if (existing) return; // already showing - no need to recreate it

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "support-btn";
  btn.className = "support-fab-btn";
  btn.textContent = "Support";
  btn.addEventListener("click", openSupportModal);
  document.body.appendChild(btn);
}

// ---- Same popup pattern as the share modal elsewhere in the app: a
// centered card with a copyable link, torn down and rebuilt in JS rather
// than sitting in the HTML the whole time. ----
function openSupportModal() {
  closeSupportModal();

  const supportUrl = "https://form.jotform.com/261882058056058";

  const overlay = document.createElement("div");
  overlay.className = "share-modal-overlay";
  overlay.id = "support-modal-overlay";
  overlay.innerHTML = `
    <div class="share-modal">
      <button type="button" class="share-modal-close" aria-label="Close">✕</button>
      <h2 class="share-modal-title">Need help or have feedback?</h2>
      <p style="color: var(--color-ink-soft); font-size: 0.88rem; margin-bottom: 18px;">
        Send us a bug report, feature request, or anything else through our support form.
      </p>
      <div class="share-modal-link-row">
        <input type="text" class="share-modal-link-input" value="${supportUrl}" readonly />
        <button type="button" class="btn btn-primary share-modal-copy-btn">Copy</button>
      </div>
      <a href="${supportUrl}" target="_blank" rel="noopener" class="btn btn-outline btn-full">Open support form ↗</a>
    </div>
  `;
  document.body.appendChild(overlay);

  // Click on the dark backdrop (but not the card itself) closes it
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSupportModal();
  });
  overlay.querySelector(".share-modal-close").addEventListener("click", closeSupportModal);

  const copyBtn = overlay.querySelector(".share-modal-copy-btn");
  const linkInput = overlay.querySelector(".share-modal-link-input");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
    } catch (error) {
      // Clipboard API can be blocked (e.g. non-HTTPS) - fall back to the
      // old select-and-copy trick so the button still works either way.
      linkInput.select();
      document.execCommand("copy");
    }
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });

  document.addEventListener("keydown", handleSupportModalEscape);
}

function closeSupportModal() {
  const existing = document.getElementById("support-modal-overlay");
  if (existing) existing.remove();
  document.removeEventListener("keydown", handleSupportModalEscape);
}

function handleSupportModalEscape(event) {
  if (event.key === "Escape") closeSupportModal();
}

// ---- helpers (same pattern as feed.js/post.js - each page is standalone) ----
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(timestamp) {
  if (!timestamp) return "just now";
  const seconds = Math.floor((Date.now() - timestamp.toDate().getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderPostCard(id, post) {
  const myVote = myVotes.get(id) || 0;

  // Images/videos are intentionally NOT shown on profile post cards - only
  // in the post detail page (post.js) once someone actually clicks in.

  return `
    <article class="post-card">
      <div class="post-votes">
        <button class="vote-btn${myVote === 1 ? " vote-btn--active-up" : ""}" data-post-id="${id}" data-direction="1">▲</button>
        <span class="vote-count">${post.votes ?? 0}</span>
        <button class="vote-btn${myVote === -1 ? " vote-btn--active-down" : ""}" data-post-id="${id}" data-direction="-1">▼</button>
      </div>
      <div class="post-body">
        <div class="post-meta">
          <span class="topic-tag">#${escapeHtml(post.topic)}</span>
          <span class="meta-text">${timeAgo(post.createdAt)}</span>
        </div>
        <a href="post.html?id=${id}" class="post-title-link">
          <h3 class="post-title">${escapeHtml(post.title)}</h3>
        </a>
        <p class="post-excerpt">${escapeHtml(post.body)}</p>
        <div class="post-actions">
          <a href="post.html?id=${id}" class="post-action">💬 ${post.commentCount ?? 0} comments</a>
        </div>
      </div>
    </article>
  `;
}

if (!uid) {
  profileHeader.innerHTML = `<p class="feed-empty">No user specified.</p>`;
  profilePosts.innerHTML = "";
} else {
  loadProfile();
  loadUserPosts();
}

// ---- Track who's logged in. This decides whether we show the Archived tab
// at all (only on your own profile) and re-renders the tabs/posts once we
// know, since this can resolve after loadUserPosts() already ran once. ----
onAuthStateChanged(auth, (user) => {
  loggedInUid = user ? user.uid : null;
  renderTabs();
  renderSupportButton();
  renderProfilePosts();
  loadMyVotes();

  // Only your own profile ever needs the saved-posts list, and only once -
  // there's no reason to keep re-subscribing every time onAuthStateChanged
  // happens to fire again with the same uid.
  if (loggedInUid === uid && !savedPostsSubscribed) {
    savedPostsSubscribed = true;
    loadSavedPosts();
  }
});

// ---- Keeps myVotes in sync with Firestore in real time (same pattern as feed.js). ----
function loadMyVotes() {
  if (unsubscribeMyVotes) unsubscribeMyVotes();

  if (!loggedInUid) {
    myVotes = new Map();
    renderProfilePosts();
    return;
  }

  const q = query(collectionGroup(db, "votes"), where("uid", "==", loggedInUid));
  unsubscribeMyVotes = onSnapshot(q, (snapshot) => {
    const updated = new Map();
    snapshot.docs.forEach((docSnap) => {
      const postId = docSnap.ref.parent.parent.id;
      updated.set(postId, docSnap.data().value);
    });
    myVotes = updated;
    renderProfilePosts();
  });
}

// ---- Casts, changes, or removes a vote (same transaction pattern as feed.js/post.js). ----
async function castVote(postId, uid, direction) {
  const voteRef = doc(db, "posts", postId, "votes", uid);
  const postRef = doc(db, "posts", postId);

  await runTransaction(db, async (transaction) => {
    const voteSnap = await transaction.get(voteRef);
    const existingValue = voteSnap.exists() ? voteSnap.data().value : 0;
    const newValue = existingValue === direction ? 0 : direction;
    const delta = newValue - existingValue;

    if (newValue === 0) {
      transaction.delete(voteRef);
    } else {
      transaction.set(voteRef, { uid, value: newValue });
    }

    transaction.update(postRef, { votes: increment(delta) });
  });
}

// ---- Vote button clicks, via event delegation (same reasoning as feed.js -
// profilePosts gets fully rebuilt on every render, so one listener on the
// container outlives any individual re-render). ----
profilePosts.addEventListener("click", (event) => {
  const voteBtn = event.target.closest(".vote-btn");
  if (!voteBtn) return;

  if (!loggedInUid) {
    alert("Please log in to vote.");
    return;
  }

  castVote(voteBtn.dataset.postId, loggedInUid, Number(voteBtn.dataset.direction));
});

// ---- Draws the tab bar in place of the plain "Posts" heading, but only on
// your own profile. On anyone else's profile it just stays a static label -
// their archived posts are theirs to see, not yours. ----
function renderTabs() {
  if (!postsSectionHeading) return;

  const isOwnProfile = loggedInUid === uid;

  if (!isOwnProfile) {
    postsSectionHeading.textContent = "Posts";
    return;
  }

  postsSectionHeading.innerHTML = `
    <div class="profile-tabs">
      <button type="button" class="profile-tab-btn${activeTab === "posts" ? " profile-tab-btn--active" : ""}" data-tab="posts">Posts</button>
      <button type="button" class="profile-tab-btn${activeTab === "archived" ? " profile-tab-btn--active" : ""}" data-tab="archived">Archived</button>
      <button type="button" class="profile-tab-btn${activeTab === "saved" ? " profile-tab-btn--active" : ""}" data-tab="saved">Saved</button>
    </div>
  `;

  postsSectionHeading.querySelectorAll(".profile-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      renderTabs(); // redraw so the newly-selected tab gets highlighted
      renderProfilePosts();
    });
  });
}

// ---- Loads the user doc (username + joined date) and their comment count ----
async function loadProfile() {
  try {
    const userSnap = await getDoc(doc(db, "users", uid));

    if (!userSnap.exists()) {
      profileHeader.innerHTML = `<p class="feed-empty">This user doesn't exist.</p>`;
      return;
    }

    const user = userSnap.data();
    const joined = user.createdAt
      ? user.createdAt.toDate().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
      : "unknown date";

    // Comments live in a SEPARATE subcollection under every post
    // (posts/{postId}/comments), not in one big "comments" collection. A
    // collectionGroup() query searches across every subcollection that shares
    // that name, no matter which post it's under - so this finds every
    // comment this user has ever written, on any post.
    //
    // getCountFromServer() is an "aggregation query" - instead of downloading
    // every single matching comment just to count them in JS, it asks
    // Firestore to do the counting on its end and just hand back the number.
    // Much cheaper for something we only need a count from.
    const commentsQuery = query(collectionGroup(db, "comments"), where("authorId", "==", uid));
    const commentsCountSnap = await getCountFromServer(commentsQuery);
    const commentCount = commentsCountSnap.data().count;

    profileHeader.innerHTML = `
      <div class="profile-header">
        <h1 class="profile-username">u/${escapeHtml(user.username)}</h1>
        <p class="profile-joined">Joined ${joined}</p>
        <div class="profile-stats">
          <div>
            <div class="profile-stat-value" id="profile-post-count">…</div>
            <div class="profile-stat-label">Posts</div>
          </div>
          <div>
            <div class="profile-stat-value">${commentCount}</div>
            <div class="profile-stat-label">Comments</div>
          </div>
        </div>
      </div>
    `;

    // The element above was JUST created - if loadUserPosts() already
    // finished (it often finishes first, since it's just a cache read),
    // this is what actually gets the number to show up.
    updatePostCountDisplay();
  } catch (error) {
    console.error("Profile load error:", error);
    profileHeader.innerHTML = `<p class="feed-empty">Couldn't load this profile. Check the console for details.</p>`;
  }
}

// ---- Loads (and live-updates) EVERY post by this user - archived or not.
// We fetch them all in one query (no extra Firestore index needed) and let
// renderProfilePosts() decide which ones actually belong on screen, based on
// the active tab. ----
function loadUserPosts() {
  const postsRef = collection(db, "posts");
  const q = query(postsRef, where("authorId", "==", uid), orderBy("createdAt", "desc"));

  onSnapshot(q, (snapshot) => {
    latestUserPosts = snapshot.docs.map((docSnap) => ({ id: docSnap.id, data: docSnap.data() }));
    renderProfilePosts();
  }, (error) => {
    console.error("Profile posts error:", error);
    profilePosts.innerHTML = `<p class="feed-empty">Couldn't load posts. Check the console for details.</p>`;
  });
}

// ---- Subscribes to this user's saved-posts subcollection, and re-hydrates
// the full post content every time that list changes. Only ever called for
// your own profile. ----
function loadSavedPosts() {
  const savedRef = collection(db, "users", uid, "savedPosts");
  const q = query(savedRef, orderBy("savedAt", "desc"));

  onSnapshot(q, async (snapshot) => {
    const savedMeta = snapshot.docs.map((d) => d.id); // just the post IDs, newest-saved first

    // Each saved-post document only tells us WHICH post was saved, not its
    // content - so we look each one up. Promise.all runs all these lookups
    // at the same time (instead of one after another), which is much faster
    // when there are several saved posts.
    const hydrated = await Promise.all(
      savedMeta.map(async (postId) => {
        const postSnap = await getDoc(doc(db, "posts", postId));
        if (!postSnap.exists()) return null; // post was deleted since being saved

        const data = postSnap.data();
        // A post someone else archived shouldn't linger in your saved list
        // as if it were still public - skip it. (You could still archive
        // your OWN saved posts and see them via the Archived tab instead.)
        if (data.archived === true) return null;

        return { id: postSnap.id, data };
      })
    );

    savedPostsResolved = hydrated.filter(Boolean); // drop the nulls from missing/archived posts
    renderProfilePosts();
  });
}

// ---- Filters latestUserPosts down to whatever the current tab should show,
// and draws it. Called whenever the posts data changes, the tab changes, or
// we find out who's logged in - since all three affect what's visible. ----
function renderProfilePosts() {
  const isOwnProfile = loggedInUid === uid;

  // The "Posts" count in the stats bar always means PUBLIC posts, regardless
  // of which tab you're currently looking at.
  const publicPosts = latestUserPosts.filter((p) => p.data.archived !== true);
  latestPostCount = publicPosts.length;
  updatePostCountDisplay();

  let visiblePosts = publicPosts;
  let emptyMessage = `<p class="feed-empty">This user hasn't posted anything yet.</p>`;

  // Archived and Saved are private, own-profile-only views - anyone else
  // visiting this profile only ever sees the public Posts list, regardless
  // of what activeTab happens to be set to.
  if (isOwnProfile && activeTab === "archived") {
    visiblePosts = latestUserPosts.filter((p) => p.data.archived === true);
    emptyMessage = `<p class="feed-empty">No archived posts. Posts you archive will show up here, visible only to you.</p>`;
  } else if (isOwnProfile && activeTab === "saved") {
    visiblePosts = savedPostsResolved;
    emptyMessage = `<p class="feed-empty">No saved posts yet. Click 🔖 Save on any post to bookmark it here.</p>`;
  }

  if (visiblePosts.length === 0) {
    profilePosts.innerHTML = emptyMessage;
    return;
  }

  profilePosts.innerHTML = visiblePosts
    .map(({ id, data }) => renderPostCard(id, data))
    .join("");
}
