// ============================================
// POST DETAIL + COMMENTS LOGIC
// ============================================

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  onSnapshot,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  addDoc,
  updateDoc,
  setDoc,
  deleteDoc,
  increment,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Get the post ID from the URL, e.g. post.html?id=abc123 ----
const params = new URLSearchParams(window.location.search);
const postId = params.get("id");

const postContainer = document.getElementById("post-container");
const commentsContainer = document.getElementById("comments-container");
const commentForm = document.getElementById("comment-form");
const commentError = document.getElementById("comment-error");

let currentUser = null;

// A live set of post IDs the current user has saved (same pattern as
// feed.js). On this page there's only ever one post to care about, but we
// keep it as a Set for consistency with how feed.js checks "is this saved?".
let savedPostIds = new Set();
let unsubscribeSaved = null;

// This user's vote on THIS post: 1 (upvoted), -1 (downvoted), or 0 (no vote).
// Only ever one post to track here, so a plain number is enough - no need
// for the Set/Map approach feed.js and profile.js use for many posts at once.
let myVoteValue = 0;
let unsubscribeMyVote = null;

// Holds whatever we last got back from Firestore for this post. We need this
// stored outside loadPost() because renderPostDetail() gets called from TWO
// different places (the post listener below, AND the login-state listener)
// and each one only knows about its own update - not the other's. Keeping
// the latest post data in a shared variable lets either one trigger a
// re-render using the full, current picture.
let currentPostData = null;

// This user's votes on THIS post's comments, as a map of commentId -> 1/-1.
// Kept separate from post-level votes (different subcollection name,
// "commentVotes" vs "votes") so a collectionGroup query on one never
// accidentally matches documents meant for the other.
let myCommentVotes = new Map();
let unsubscribeMyCommentVotes = null;

if (!postId) {
  postContainer.innerHTML = `<p class="feed-empty">No post specified.</p>`;
} else {
  loadPost();
  loadComments();
}

// ---- Track login state (needed so we know who's commenting, AND whether
// the person viewing this page is the post's author - that's what decides
// if they get an Archive button, or see an archived post at all). ----
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  loadSavedPostIds();
  loadMyVote();
  loadMyCommentVotes();
  renderPostDetail(); // re-check now that we know who's logged in
});

// ---- Keeps myCommentVotes in sync with Firestore in real time. A
// collectionGroup query on "commentVotes" catches this user's vote on any
// comment under THIS post (or any post, technically - but since only this
// post's comments are ever rendered here, that's harmless). ----
function loadMyCommentVotes() {
  if (unsubscribeMyCommentVotes) unsubscribeMyCommentVotes();

  if (!currentUser) {
    myCommentVotes = new Map();
    return; // loadComments' own listener will re-render with the fresh (empty) map
  }

  const q = query(collectionGroup(db, "commentVotes"), where("uid", "==", currentUser.uid));
  unsubscribeMyCommentVotes = onSnapshot(q, (snapshot) => {
    const updated = new Map();
    snapshot.docs.forEach((docSnap) => {
      // commentVotes doc path: .../comments/{commentId}/commentVotes/{uid}
      // so its "grandparent" document is the comment itself.
      const commentId = docSnap.ref.parent.parent.id;
      updated.set(commentId, docSnap.data().value);
    });
    myCommentVotes = updated;
    renderCommentsFromCache();
  });
}

// ---- Casts, changes, or removes a vote on a COMMENT (separate subcollection
// from post votes - same transaction pattern otherwise). ----
async function castCommentVote(commentId, uid, direction) {
  const voteRef = doc(db, "posts", postId, "comments", commentId, "commentVotes", uid);
  const commentRef = doc(db, "posts", postId, "comments", commentId);

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

    transaction.update(commentRef, { votes: increment(delta) });
  });
}

// ---- Keeps myVoteValue in sync with Firestore in real time, same pattern
// as loadSavedPostIds() just below. ----
function loadMyVote() {
  if (unsubscribeMyVote) unsubscribeMyVote();

  if (!currentUser) {
    myVoteValue = 0;
    renderPostDetail();
    return;
  }

  const voteRef = doc(db, "posts", postId, "votes", currentUser.uid);
  unsubscribeMyVote = onSnapshot(voteRef, (docSnap) => {
    myVoteValue = docSnap.exists() ? docSnap.data().value : 0;
    renderPostDetail();
  });
}

// ---- Keeps savedPostIds in sync with Firestore in real time (same idea as
// feed.js's version of this function). ----
function loadSavedPostIds() {
  if (unsubscribeSaved) unsubscribeSaved();

  if (!currentUser) {
    savedPostIds = new Set();
    renderPostDetail();
    return;
  }

  const savedRef = collection(db, "users", currentUser.uid, "savedPosts");
  unsubscribeSaved = onSnapshot(savedRef, (snapshot) => {
    savedPostIds = new Set(snapshot.docs.map((d) => d.id));
    renderPostDetail();
  });
}

// ---- helpers (same as feed.js - kept local since each page is standalone) ----
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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---- Small inline SVG icons - kept as plain template strings (no icon
// font/library needed) so the bookmark can flip between hollow and filled
// just by swapping the `fill` attribute. ----
function bookmarkIcon(filled) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
}

function archiveIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
}

function trashIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
}

function shareIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
}

// ---- Builds and shows the centered "share this post" popup (link + copy
// button + who/when/topic info), same as the one on the home feed. Only
// ever one of these open at a time - openShareModal() always clears out any
// previous one first. ----
function openShareModal(post) {
  closeShareModal();

  const shareUrl = new URL("post.html", window.location.href);
  shareUrl.searchParams.set("id", post.id);

  const overlay = document.createElement("div");
  overlay.className = "share-modal-overlay";
  overlay.id = "share-modal-overlay";
  overlay.innerHTML = `
    <div class="share-modal">
      <button type="button" class="share-modal-close" aria-label="Close">✕</button>
      <h2 class="share-modal-title">Share this post</h2>
      <div class="share-modal-link-row">
        <input type="text" class="share-modal-link-input" value="${shareUrl.href}" readonly />
        <button type="button" class="btn btn-primary share-modal-copy-btn">Copy</button>
      </div>
      <div class="share-modal-meta">
        <span><strong>Topic:</strong> #${escapeHtml(post.topic)}</span>
        <span><strong>Posted by:</strong> u/${escapeHtml(post.authorName)}</span>
        <span><strong>Posted:</strong> ${timeAgo(post.createdAt)}</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Click on the dark backdrop (but not the card itself) closes it
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeShareModal();
  });
  overlay.querySelector(".share-modal-close").addEventListener("click", closeShareModal);

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

  document.addEventListener("keydown", handleShareModalEscape);
}

function closeShareModal() {
  const existing = document.getElementById("share-modal-overlay");
  if (existing) existing.remove();
  document.removeEventListener("keydown", handleShareModalEscape);
}

function handleShareModalEscape(event) {
  if (event.key === "Escape") closeShareModal();
}

// ---- Casts, changes, or removes a vote on a post, using a TRANSACTION.
// A transaction reads current values and writes new ones as one atomic
// unit - Firestore guarantees nobody else's write can sneak in between the
// read and the write. That matters here because the new vote total depends
// on the OLD total (old total + delta), and two people voting at the exact
// same moment could otherwise silently overwrite each other's change if we
// just read-then-wrote normally. ----
async function castVote(postId, uid, direction) {
  const voteRef = doc(db, "posts", postId, "votes", uid);
  const postRef = doc(db, "posts", postId);

  await runTransaction(db, async (transaction) => {
    const voteSnap = await transaction.get(voteRef);
    const existingValue = voteSnap.exists() ? voteSnap.data().value : 0;

    // Clicking the same arrow you already picked undoes your vote (back to
    // neutral). Clicking the other arrow switches straight over.
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

// ---- Permanently deletes this post. Only ever called from a button that's
// only shown to the post's own author (see renderPostDetail below) - but
// note this is a UI-level restriction only, since Firestore is still in
// test mode. Real enforcement needs security rules, which we'll add later. ----
async function deletePost() {
  const confirmed = confirm("Delete this post permanently? This can't be undone.");
  if (!confirmed) return;

  await deleteDoc(doc(db, "posts", postId));
  window.location.href = "index.html";
}

// ---- Load the post itself. Just STORES the data and hands off to
// renderPostDetail() - it doesn't build any HTML directly, since the HTML
// depends on both this data AND who's logged in (see currentPostData above). ----
function loadPost() {
  const postRef = doc(db, "posts", postId);

  onSnapshot(postRef, (docSnap) => {
    if (!docSnap.exists()) {
      postContainer.innerHTML = `<p class="feed-empty">This post doesn't exist (maybe it was deleted).</p>`;
      currentPostData = null;
      return;
    }

    currentPostData = { id: docSnap.id, ...docSnap.data() };
    renderPostDetail();
  });
}

// ---- Draws the post card into the page. Called whenever EITHER the post
// data OR the login state changes, since both affect what should show. ----
function renderPostDetail() {
  if (!currentPostData) return; // post hasn't loaded yet (or doesn't exist)

  const post = currentPostData;
  const isOwner = currentUser && currentUser.uid === post.authorId;

  // If this post is archived and you're not its author, you don't get to
  // see it at all - just a placeholder. (Reminder: this is a UI-level check
  // only, since Firestore is still in test mode. Real access control comes
  // later with security rules.)
  if (post.archived && !isOwner) {
    postContainer.innerHTML = `<p class="feed-empty">This post has been archived by its author.</p>`;
    return;
  }

  // Only the author gets Archive/Delete buttons, and only they see the
  // little "archived" banner reminding them it's hidden from everyone else.
  const archiveButton = isOwner
    ? `<button type="button" class="icon-btn archive-icon-btn${post.archived ? " archive-icon-btn--active" : ""}" id="archive-toggle-btn" title="${post.archived ? "Unarchive" : "Archive"}" aria-label="${post.archived ? "Unarchive" : "Archive"}">
         ${archiveIcon()}
       </button>`
    : "";

  const deleteButton = isOwner
    ? `<button type="button" class="icon-btn delete-icon-btn" id="delete-post-btn" title="Delete" aria-label="Delete">
         ${trashIcon()}
       </button>`
    : "";

  const archivedBanner = post.archived
    ? `<p class="archived-banner">🗄 Archived — only you can see this post</p>`
    : "";

  // Anyone logged in can save any post (including their own) - unlike
  // Archive, this isn't restricted to the author.
  const isSaved = savedPostIds.has(post.id);
  const saveButton = currentUser
    ? `<button type="button" class="icon-btn save-icon-btn${isSaved ? " save-icon-btn--active" : ""}" id="save-toggle-btn" title="${isSaved ? "Saved" : "Save"}" aria-label="${isSaved ? "Saved" : "Save"}">
         ${bookmarkIcon(isSaved)}
       </button>`
    : "";

  // --- DYNAMIC MEDIA HANDLING ---
  // Generate the image or video container if mediaUrl exists in Firestore
  let mediaBlock = "";
  if (post.mediaUrl) {
    if (post.mediaType === "video") {
      mediaBlock = `
        <div class="post-media-content" style="margin: 15px 0; width: 100%;">
          <video src="${post.mediaUrl}" controls style="width: 100%; max-height: 450px; border-radius: 8px; display: block; background: #000;"></video>
        </div>
      `;
    } else {
      mediaBlock = `
        <div class="post-media-content" style="margin: 15px 0; width: 100%;">
          <img src="${post.mediaUrl}" alt="Post attachment" style="width: 100%; max-height: 450px; object-fit: contain; border-radius: 8px; display: block;" />
        </div>
      `;
    }
  }

  postContainer.innerHTML = `
    <article class="post-card post-detail">
      <button type="button" class="icon-btn share-icon-btn post-detail-share-btn" id="detail-share-btn" title="Share" aria-label="Share">
        ${shareIcon()}
      </button>
      <div class="post-votes">
        <button class="vote-btn${myVoteValue === 1 ? " vote-btn--active-up" : ""}" id="upvote-btn">▲</button>
        <span class="vote-count">${post.votes ?? 0}</span>
        <button class="vote-btn${myVoteValue === -1 ? " vote-btn--active-down" : ""}" id="downvote-btn">▼</button>
      </div>
      <div class="post-body">
        ${archivedBanner}
        <div class="post-meta">
          <span class="topic-tag">#${escapeHtml(post.topic)}</span>
          <span class="meta-text">posted by <a href="profile.html?uid=${encodeURIComponent(post.authorId)}" class="username">u/${escapeHtml(post.authorName)}</a> · ${timeAgo(post.createdAt)}</span>
        </div>
        <h1 class="post-title">${escapeHtml(post.title)}</h1>
        <p class="post-excerpt post-full-body">${escapeHtml(post.body)}</p>
        ${mediaBlock} <!-- Dynamic Image/Video output rendering target location -->
        ${(archiveButton || deleteButton || saveButton) ? `<div class="post-actions"><div class="post-actions-icons">${saveButton}${archiveButton}${deleteButton}</div></div>` : ""}
      </div>
    </article>
  `;

  // Re-attach button click handlers - innerHTML above wiped out whatever
  // listeners existed before this render.
  document.getElementById("upvote-btn").addEventListener("click", () => {
    if (!currentUser) { alert("Please log in to vote."); return; }
    castVote(postId, currentUser.uid, 1);
  });

  document.getElementById("downvote-btn").addEventListener("click", () => {
    if (!currentUser) { alert("Please log in to vote."); return; }
    castVote(postId, currentUser.uid, -1);
  });

  document.getElementById("detail-share-btn").addEventListener("click", () => {
    openShareModal(post);
  });

  if (isOwner) {
    document.getElementById("archive-toggle-btn").addEventListener("click", async () => {
      await updateDoc(doc(db, "posts", postId), {
        archived: !post.archived
      });
      // No need to manually re-render here - updateDoc() triggers our
      // onSnapshot listener in loadPost(), which updates currentPostData
      // and calls renderPostDetail() for us automatically.
    });

    document.getElementById("delete-post-btn").addEventListener("click", deletePost);
  }

  if (currentUser) {
    document.getElementById("save-toggle-btn").addEventListener("click", async () => {
      const savedRef = doc(db, "users", currentUser.uid, "savedPosts", post.id);
      if (savedPostIds.has(post.id)) {
        await deleteDoc(savedRef);
      } else {
        await setDoc(savedRef, { postId: post.id, savedAt: serverTimestamp() });
      }
      // Same deal - the savedPosts onSnapshot listener picks this up and
      // calls renderPostDetail() for us.
    });
  }
}

// ---- Load and render comments as a nested tree ----
let latestCommentDocs = []; // cached so renderCommentsFromCache() can redraw without a fresh Firestore read

function loadComments() {
  const commentsRef = collection(db, "posts", postId, "comments");
  const q = query(commentsRef, orderBy("createdAt", "asc"));

  onSnapshot(q, (snapshot) => {
    latestCommentDocs = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    renderCommentsFromCache();
  });
}

// ---- Draws the comment tree from whatever's currently in latestCommentDocs.
// Split out from loadComments() so BOTH a new comment/reply AND a vote
// change (which doesn't touch the comments themselves, just our own vote
// map) can trigger a redraw without needing two separate render paths. ----
function renderCommentsFromCache() {
  if (latestCommentDocs.length === 0) {
    commentsContainer.innerHTML = `<p class="feed-empty">No comments yet. Start the conversation!</p>`;
    return;
  }

  // Turn the flat list of comments into a tree, grouped by parentId.
  // "roots" = top-level comments (parentId is null)
  // "childrenOf" = a lookup: commentId -> array of its replies
  const roots = [];
  const childrenOf = {};

  latestCommentDocs.forEach((comment) => {
    if (comment.parentId) {
      if (!childrenOf[comment.parentId]) childrenOf[comment.parentId] = [];
      childrenOf[comment.parentId].push(comment);
    } else {
      roots.push(comment);
    }
  });

  // Recursively render a comment and all its replies underneath it.
  // We cap the VISUAL indent at a max depth so deeply nested reply chains
  // don't push the layout off the side of the screen - replies past that
  // depth still nest logically, they just stop indenting further right.
  const MAX_VISUAL_DEPTH = 5;

  function renderComment(comment, depth) {
    const replies = childrenOf[comment.id] || [];
    const repliesHtml = replies.map((reply) => renderComment(reply, depth + 1)).join("");
    const visualDepth = Math.min(depth, MAX_VISUAL_DEPTH);
    const myVote = myCommentVotes.get(comment.id) || 0;

    return `
      <div class="comment-item" style="margin-left: ${visualDepth * 28}px;">
        <div class="comment-votes-row">
          <button class="vote-btn comment-vote-btn${myVote === 1 ? " vote-btn--active-up" : ""}" data-comment-id="${comment.id}" data-direction="1">▲</button>
          <span class="vote-count">${comment.votes ?? 0}</span>
          <button class="vote-btn comment-vote-btn${myVote === -1 ? " vote-btn--active-down" : ""}" data-comment-id="${comment.id}" data-direction="-1">▼</button>
        </div>
        <div class="comment-main">
          <div class="comment-meta">
            <a href="profile.html?uid=${encodeURIComponent(comment.authorId)}" class="username">u/${escapeHtml(comment.authorName)}</a>
            <span class="meta-text">· ${timeAgo(comment.createdAt)}</span>
          </div>
          <p class="comment-body">${escapeHtml(comment.body)}</p>
          <div class="comment-actions">
            <button class="post-action reply-toggle" data-comment-id="${comment.id}">↩ Reply</button>
          </div>

          <!-- Hidden reply form, shown when "Reply" is clicked -->
          <form class="reply-form" data-parent-id="${comment.id}" style="display:none;">
            <textarea rows="2" placeholder="Write a reply..." required maxlength="2000"></textarea>
            <button type="submit" class="btn btn-primary btn-small">Reply</button>
          </form>

          ${repliesHtml}
        </div>
      </div>
    `;
  }

  commentsContainer.innerHTML = roots.map((r) => renderComment(r, 0)).join("");

  attachCommentEvents();
}

// ---- Comment vote clicks, via event delegation on the container - this way
// it keeps working even though renderCommentsFromCache() rebuilds the whole
// comment tree's HTML on every single change. ----
commentsContainer.addEventListener("click", (event) => {
  const voteBtn = event.target.closest(".comment-vote-btn");
  if (!voteBtn) return;

  if (!currentUser) {
    alert("Please log in to vote.");
    return;
  }

  castCommentVote(voteBtn.dataset.commentId, currentUser.uid, Number(voteBtn.dataset.direction));
});

// ---- Wires up "Reply" buttons and reply-form submissions.
// Runs every time comments re-render, since those buttons are recreated each time. ----
function attachCommentEvents() {
  document.querySelectorAll(".reply-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = document.querySelector(`.reply-form[data-parent-id="${btn.dataset.commentId}"]`);
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
  });

  document.querySelectorAll(".reply-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!currentUser) {
        alert("Please log in to reply.");
        return;
      }

      const textarea = form.querySelector("textarea");
      const body = textarea.value.trim();
      if (!body) return;

      await postComment(body, form.dataset.parentId);
      textarea.value = "";
      form.style.display = "none";
    });
  });
}

// ---- Shared function for saving a comment (used by both the top-level form and replies) ----
async function postComment(body, parentId) {
  const commentsRef = collection(db, "posts", postId, "comments");

  await addDoc(commentsRef, {
    body: body,
    authorId: currentUser.uid,
    authorName: currentUser.displayName || currentUser.email,
    parentId: parentId || null,
    votes: 0,
    createdAt: serverTimestamp()
  });

  // Keep the post's commentCount field in sync so the feed shows an accurate number.
  // increment(1) tells Firestore to add 1 to whatever the current value is -
  // this is safer than reading the value and writing value+1 yourself, since
  // two people commenting at the same instant could otherwise overwrite each other.
  await updateDoc(doc(db, "posts", postId), {
    commentCount: increment(1)
  });
}

// ---- Top-level comment form ----
commentForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentUser) {
    commentError.textContent = "Please log in to comment.";
    commentError.style.display = "block";
    return;
  }

  const textarea = document.getElementById("comment-body");
  const body = textarea.value.trim();
  if (!body) return;

  await postComment(body, null);
  textarea.value = "";
});