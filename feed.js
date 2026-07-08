// ============================================
// HOME FEED LOGIC
// Reads posts from Firestore and renders them.
// Also wires up the sidebar topic links to filter the feed.
// ============================================

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  increment,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const postsContainer = document.getElementById("posts-container");
const feedHeading = document.getElementById("feed-heading");
const paginationControls = document.getElementById("pagination-controls");
const topicList = document.getElementById("topic-list");
const searchInput = document.getElementById("search-input");
const searchDropdown = document.getElementById("search-dropdown");
const newTopicBtn = document.getElementById("new-topic-btn");
const newTopicForm = document.getElementById("new-topic-form");
const newTopicInput = document.getElementById("new-topic-input");
const newTopicError = document.getElementById("new-topic-error");

// These 5 always exist, regardless of what's in Firestore - anything users
// add on top of these gets merged in by loadTopics() below.
const DEFAULT_TOPICS = ["general", "webdev", "gaming", "music", "askanything"];

// Who's logged in right now (needed to know WHOSE saved-posts list to check/
// write to, and to block saving entirely if nobody's logged in).
let currentUser = null;

// A live set of post IDs the current user has saved, e.g. {"abc123", "xyz789"}.
// A Set makes "is this post saved?" a fast .has() check when rendering each
// card. Kept in sync in real time via onSnapshot, same as everything else.
let savedPostIds = new Set();
let unsubscribeSaved = null;

// Keeps track of the currently-running Firestore listener, so we can turn it
// off before starting a new one (e.g. when switching topics).
let unsubscribe = null;

// Firestore can't do text search (no "contains" queries), so instead we keep
// the most recent batch of posts it gave us sitting in memory here, and
// filter/re-render THAT in plain JS whenever the search box changes. This
// means searching doesn't need to talk to Firestore at all - it's instant.
let latestPosts = []; // array of { id, data } objects
let searchTerm = "";

// Same idea, but for the search dropdown's "Users" section - a live cache of
// everyone in the "users" collection, kept in sync via onSnapshot below.
let latestUsers = []; // array of { id, data } objects

// Every topic that currently exists (defaults + anything users have added),
// kept live via loadTopics() below. Starts as just the defaults so the
// sidebar/search aren't empty for the split-second before Firestore responds.
let TOPICS = [...DEFAULT_TOPICS];

// Which topic is currently selected - tracked here (not just via CSS class)
// so re-rendering the topic list after a Firestore update doesn't lose track
// of what should stay highlighted.
let activeTopic = "all";

// This user's votes across every post they've ever voted on, as a map of
// postId -> 1 (upvoted) or -1 (downvoted). A single collectionGroup query
// gets ALL of it in one shot (rather than a separate listener per post card).
let myVotes = new Map();
let unsubscribeMyVotes = null;

// ---- Pagination: keeps a single page's worth of posts on screen at a time
// instead of one long scroll. Purely client-side - we already have every
// matching post sitting in memory (see latestPosts/matches above), so a
// "page" is just a slice of that array; no extra Firestore reads needed. ----
const POSTS_PER_PAGE = 8;
let currentPage = 1;

// How many topics show directly in the sidebar before it switches to a
// "View more" link pointing at the full alphabetical list (topics.html).
const SIDEBAR_TOPIC_LIMIT = 10;

// ---- Turns a Firestore timestamp into something readable like "2h ago" ----
function timeAgo(timestamp) {
  if (!timestamp) return "just now"; // covers the split-second before the server timestamp lands

  const seconds = Math.floor((Date.now() - timestamp.toDate().getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---- Escapes user-typed text before we insert it as HTML.
// Without this, someone could type something like <script> into a post title
// and it would actually run in other people's browsers. Always escape
// user content before using innerHTML. ----
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

function shareIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
}

// ---- Builds and shows the centered "share this post" popup (link + copy
// button + who/when/topic info), similar to YouTube's share dialog. Only
// ever one of these open at a time - openShareModal() always clears out any
// previous one first. ----
function openShareModal(postId, post) {
  closeShareModal();

  const shareUrl = new URL("post.html", window.location.href);
  shareUrl.searchParams.set("id", postId);

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

// ---- Builds the HTML for a single post card ----
function renderPostCard(id, post) {
  const title = escapeHtml(post.title);
  const body = escapeHtml(post.body);
  const author = escapeHtml(post.authorName);
  const topic = escapeHtml(post.topic);
  const isSaved = savedPostIds.has(id);
  const myVote = myVotes.get(id) || 0;

  // Images/videos are intentionally NOT shown on the feed card - only in the
  // post detail page (post.js) once someone actually clicks in.

  return `
    <article class="post-card">
      <div class="post-votes">
        <button class="vote-btn${myVote === 1 ? " vote-btn--active-up" : ""}" data-post-id="${id}" data-direction="1">▲</button>
        <span class="vote-count">${post.votes ?? 0}</span>
        <button class="vote-btn${myVote === -1 ? " vote-btn--active-down" : ""}" data-post-id="${id}" data-direction="-1">▼</button>
      </div>

      <div class="post-body">
        <div class="post-meta">
          <span class="topic-tag">#${topic}</span>
          <span class="meta-text">posted by <a href="profile.html?uid=${encodeURIComponent(post.authorId)}" class="username">u/${author}</a> · ${timeAgo(post.createdAt)}</span>
        </div>
        <a href="post.html?id=${id}" class="post-title-link">
          <h3 class="post-title">${title}</h3>
        </a>
        <p class="post-excerpt">${body}</p>
        <div class="post-actions">
          <a href="post.html?id=${id}" class="post-action">💬 ${post.commentCount ?? 0} comments</a>
          <div class="post-actions-icons">
            <button type="button" class="icon-btn save-icon-btn${isSaved ? " save-icon-btn--active" : ""}" data-post-id="${id}" title="${isSaved ? "Saved" : "Save"}" aria-label="${isSaved ? "Saved" : "Save"}">
              ${bookmarkIcon(isSaved)}
            </button>
            <button type="button" class="icon-btn share-icon-btn" data-post-id="${id}" title="Share" aria-label="Share">
              ${shareIcon()}
            </button>
          </div>
        </div>
      </div>
    </article>
  `;
}

// ---- Applies the current search term to whatever posts we last got from
// Firestore, and draws the result to the page. Called both when new data
// arrives from Firestore AND when someone types in the search box. ----
function renderFeed() {
  // Archived posts are hidden from the public feed. We filter them out here
  // (in memory) rather than adding "archived == false" to the Firestore
  // query itself - that would need a brand new composite index for every
  // topic combination, whereas this is free and instant since we already
  // have all the matching-topic posts sitting in latestPosts.
  const nonArchived = latestPosts.filter(({ data }) => data.archived !== true);

  if (nonArchived.length === 0) {
    postsContainer.innerHTML = `<p class="feed-empty">No posts here yet. Be the first!</p>`;
    paginationControls.innerHTML = "";
    return;
  }

  // No search term? Show everything. Otherwise keep only posts where the
  // title OR body contains the search text (case-insensitive).
  const term = searchTerm.trim().toLowerCase();

  const matches = term === ""
    ? nonArchived
    : nonArchived.filter(({ data }) => {
        const title = (data.title || "").toLowerCase();
        const body = (data.body || "").toLowerCase();
        return title.includes(term) || body.includes(term);
      });

  if (matches.length === 0) {
    postsContainer.innerHTML = `<p class="feed-empty">No posts match "${escapeHtml(searchTerm)}".</p>`;
    paginationControls.innerHTML = "";
    return;
  }

  // ---- Pagination: clamp currentPage in case the result set shrank (e.g.
  // someone typed a narrower search, or a post got archived/deleted) since
  // the last time we were on, say, page 3 but now there's only 1 page. ----
  const totalPages = Math.ceil(matches.length / POSTS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * POSTS_PER_PAGE;
  const pageMatches = matches.slice(startIndex, startIndex + POSTS_PER_PAGE);

  postsContainer.innerHTML = pageMatches
    .map(({ id, data }) => renderPostCard(id, data))
    .join("");

  renderPaginationControls(totalPages);
}

// ---- Draws the Prev / page-number / Next controls under the feed. Hidden
// entirely when everything fits on one page - no point showing controls
// with nothing to navigate to. ----
function renderPaginationControls(totalPages) {
  if (totalPages <= 1) {
    paginationControls.innerHTML = "";
    return;
  }

  let buttons = `<button type="button" class="pagination-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>← Prev</button>`;

  for (let page = 1; page <= totalPages; page++) {
    buttons += `<button type="button" class="pagination-btn${page === currentPage ? " pagination-btn--active" : ""}" data-page="${page}">${page}</button>`;
  }

  buttons += `<button type="button" class="pagination-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>Next →</button>`;

  paginationControls.innerHTML = buttons;
}

// ---- Pagination button clicks, via event delegation (same reasoning as
// everywhere else - the controls get fully rebuilt on every render). ----
paginationControls.addEventListener("click", (event) => {
  const btn = event.target.closest(".pagination-btn");
  if (!btn || btn.disabled) return;

  currentPage = Number(btn.dataset.page);
  renderFeed();
  window.scrollTo({ top: 0, behavior: "smooth" }); // jump back up so the new page's posts are visible
});

// ---- Keeps the "Home feed" / "Posts on #topic" heading in sync with
// whichever topic is currently selected. ----
function updateFeedHeading() {
  if (!feedHeading) return;
  feedHeading.textContent = activeTopic === "all" ? "Home feed" : `Posts on #${activeTopic}`;
}

// ---- Subscribes to posts for a given topic ("all" = no filter) ----
function loadFeed(topic) {
  // Stop listening to the previous query, if there was one
  if (unsubscribe) unsubscribe();

  currentPage = 1; // switching topics always starts back at page 1
  updateFeedHeading();
  postsContainer.innerHTML = `<p class="feed-loading">Loading posts...</p>`;

  const postsRef = collection(db, "posts");

  // Build the query: filter by topic unless "all" is selected, always newest-first
  const q = topic === "all"
    ? query(postsRef, orderBy("createdAt", "desc"))
    : query(postsRef, where("topic", "==", topic), orderBy("createdAt", "desc"));

  // onSnapshot = a REAL-TIME listener. Unlike a one-time fetch, this function
  // re-runs automatically whenever matching data changes (e.g. someone posts).
  // That's why a new post shows up without needing to refresh the page.
  // NOTE: it no longer renders directly - it just updates latestPosts and
  // lets renderFeed() decide what actually gets shown (post-search-filter).
  unsubscribe = onSnapshot(q, (snapshot) => {
    latestPosts = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    renderFeed();
  }, (error) => {
    console.error("Feed error:", error);
    postsContainer.innerHTML = `<p class="feed-empty">Couldn't load posts. Check the console for details.</p>`;
  });
}

// ---- Subscribes to the "users" collection so the search dropdown always has
// an up-to-date list of usernames to match against. ----
function loadUsers() {
  onSnapshot(collection(db, "users"), (snapshot) => {
    latestUsers = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    renderSearchDropdown(); // refresh in case someone's mid-search right now
  }, (error) => {
    console.error("Users load error:", error);
  });
}

// ---- Subscribes to the "topics" collection (anything users have added on
// top of the defaults), merges it with DEFAULT_TOPICS, and re-renders the
// sidebar list whenever it changes. ----
function loadTopics() {
  onSnapshot(collection(db, "topics"), (snapshot) => {
    const customTopics = snapshot.docs.map((d) => d.id);
    // Merge defaults + custom, drop duplicates, alphabetical for predictability
    const merged = Array.from(new Set([...DEFAULT_TOPICS, ...customTopics])).sort();
    TOPICS = merged;
    renderTopicList();
  }, (error) => {
    console.error("Topics load error:", error);
  });
}

// ---- Draws the sidebar's topic links (all + up to SIDEBAR_TOPIC_LIMIT
// entries from TOPICS), highlighting whichever one is currently active.
// If there are more topics than fit, a "View more" link takes you to
// topics.html for the full alphabetical list instead of cramming them all in. ----
function renderTopicList() {
  const allLi = `<li><a href="#" class="topic-tag${activeTopic === "all" ? " topic-tag--active" : ""}" data-topic="all">#all</a></li>`;

  // #all always occupies one of the sidebar's SIDEBAR_TOPIC_LIMIT slots, so
  // only (SIDEBAR_TOPIC_LIMIT - 1) real topics can fit alongside it before
  // the next one has to become "View more" instead.
  const maxRealTopics = SIDEBAR_TOPIC_LIMIT - 1;
  const needsViewMore = TOPICS.length > maxRealTopics;
  const visibleTopics = needsViewMore ? TOPICS.slice(0, maxRealTopics) : TOPICS;

  const topicLis = visibleTopics.map((topic) => `
    <li><a href="#" class="topic-tag${activeTopic === topic ? " topic-tag--active" : ""}" data-topic="${escapeHtml(topic)}">#${escapeHtml(topic)}</a></li>
  `).join("");

  const viewMoreLi = needsViewMore
    ? `<li><a href="topics.html" class="view-more-topics-link">View more →</a></li>`
    : "";

  topicList.innerHTML = allLi + topicLis + viewMoreLi;
}

// ---- Switches the feed to a given topic AND keeps the sidebar highlight in
// sync. Pulled out into its own function since both the sidebar links and the
// search dropdown's topic results need to do this exact same thing. ----
function selectTopic(topic) {
  activeTopic = topic;
  renderTopicList();
  loadFeed(topic);
}

// ---- One listener on the whole list (event delegation) instead of one per
// link - this way it keeps working even after renderTopicList() rebuilds
// the list's HTML from scratch (which would silently drop any listeners
// attached directly to the old links). ----
topicList.addEventListener("click", (event) => {
  const link = event.target.closest(".topic-tag[data-topic]");
  if (!link) return;
  event.preventDefault();
  selectTopic(link.dataset.topic);
});

// ---- "+ New topic" button: toggles the inline add-topic form ----
newTopicBtn.addEventListener("click", () => {
  newTopicForm.classList.toggle("open");
  newTopicError.style.display = "none";
  if (newTopicForm.classList.contains("open")) newTopicInput.focus();
});

// ---- Turns whatever someone typed into a clean, URL/Firestore-safe topic
// slug: lowercase, letters/numbers only, no spaces or symbols. ----
function slugifyTopic(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

newTopicForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentUser) {
    newTopicError.textContent = "Please log in to create a topic.";
    newTopicError.style.display = "block";
    return;
  }

  const slug = slugifyTopic(newTopicInput.value);

  if (slug.length < 2) {
    newTopicError.textContent = "Topic name needs at least 2 letters/numbers.";
    newTopicError.style.display = "block";
    return;
  }

  if (TOPICS.includes(slug)) {
    // Already exists (default or previously created) - just switch to it,
    // no need to create a duplicate document.
    newTopicInput.value = "";
    newTopicForm.classList.remove("open");
    selectTopic(slug);
    return;
  }

  try {
    // Using the slug itself as the document ID means Firestore naturally
    // prevents two people from creating "webdev" twice at the same time -
    // the second attempt just overwrites the same doc rather than making a
    // second one.
    await setDoc(doc(db, "topics", slug), {
      name: slug,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp()
    });

    newTopicInput.value = "";
    newTopicForm.classList.remove("open");
    selectTopic(slug); // jump straight to the new topic
  } catch (error) {
    newTopicError.textContent = "Something went wrong creating that topic. Please try again.";
    newTopicError.style.display = "block";
  }
});

// ---- Builds the "matching topics / matching users" dropdown under the
// search box. This is separate from renderFeed() because it searches
// DIFFERENT data (topics + usernames, not post titles/bodies). ----
function renderSearchDropdown() {
  const term = searchTerm.trim().toLowerCase();

  if (term === "") {
    searchDropdown.classList.remove("visible");
    searchDropdown.innerHTML = "";
    return;
  }

  const matchingTopics = TOPICS.filter((topic) => topic.toLowerCase().includes(term));
  const matchingUsers = latestUsers.filter(({ data }) =>
    (data.username || "").toLowerCase().includes(term)
  );

  if (matchingTopics.length === 0 && matchingUsers.length === 0) {
    searchDropdown.classList.remove("visible");
    searchDropdown.innerHTML = "";
    return;
  }

  let html = "";

  if (matchingTopics.length > 0) {
    html += `
      <div class="search-dropdown-section">
        <div class="search-dropdown-heading">Topics</div>
        ${matchingTopics.map((topic) => `
          <button type="button" class="search-result-item search-result-topic-btn" data-topic="${escapeHtml(topic)}">
            #${escapeHtml(topic)}
          </button>
        `).join("")}
      </div>
    `;
  }

  if (matchingUsers.length > 0) {
    html += `
      <div class="search-dropdown-section">
        <div class="search-dropdown-heading">Users</div>
        ${matchingUsers.map(({ id, data }) => `
          <button type="button" class="search-result-item search-result-user-btn" data-uid="${id}">
            u/${escapeHtml(data.username || "unknown")}
          </button>
        `).join("")}
      </div>
    `;
  }

  searchDropdown.innerHTML = html;
  searchDropdown.classList.add("visible");
}

// ---- Wire up the search box: every keystroke re-filters and re-renders
// whatever posts we already have in memory (no new Firestore request), and
// refreshes the topics/users dropdown too. ----
if (searchInput) {
  searchInput.addEventListener("input", (event) => {
    searchTerm = event.target.value;
    currentPage = 1; // a new search always starts back at page 1
    renderFeed();
    renderSearchDropdown();
  });
}

// ---- Clicking a result in the dropdown ----
if (searchDropdown) {
  searchDropdown.addEventListener("click", (event) => {
    const topicBtn = event.target.closest(".search-result-topic-btn");
    if (topicBtn) {
      // Clear the search box and switch the feed over to that topic
      searchInput.value = "";
      searchTerm = "";
      searchDropdown.classList.remove("visible");
      searchDropdown.innerHTML = "";
      selectTopic(topicBtn.dataset.topic);
      return;
    }

    const userBtn = event.target.closest(".search-result-user-btn");
    if (userBtn) {
      window.location.href = `profile.html?uid=${encodeURIComponent(userBtn.dataset.uid)}`;
    }
  });
}

// ---- Close the dropdown if someone clicks anywhere outside the search box ----
document.addEventListener("click", (event) => {
  if (!event.target.closest(".navbar-search")) {
    searchDropdown.classList.remove("visible");
  }
});

// ---- Track login state, and (re)subscribe to this user's saved-post IDs
// whenever it changes (including logging out, which clears the list). ----
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  loadSavedPostIds();
  loadMyVotes();
});

// ---- Keeps myVotes in sync with Firestore in real time. A collectionGroup
// query searches every "votes" subcollection across every post at once - so
// this one listener covers this user's votes on ANY post, not just the ones
// currently visible in the feed. ----
function loadMyVotes() {
  if (unsubscribeMyVotes) unsubscribeMyVotes();

  if (!currentUser) {
    myVotes = new Map();
    renderFeed();
    return;
  }

  const q = query(collectionGroup(db, "votes"), where("uid", "==", currentUser.uid));
  unsubscribeMyVotes = onSnapshot(q, (snapshot) => {
    const updated = new Map();
    snapshot.docs.forEach((docSnap) => {
      // A vote doc's path looks like posts/{postId}/votes/{uid} - its
      // "grandparent" (the parent of its parent collection) is the post.
      const postId = docSnap.ref.parent.parent.id;
      updated.set(postId, docSnap.data().value);
    });
    myVotes = updated;
    renderFeed();
  });
}

// ---- Casts, changes, or removes a vote using a transaction (same pattern
// as post.js - see the comment there for why a transaction matters here). ----
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

// ---- Keeps savedPostIds in sync with Firestore in real time. ----
function loadSavedPostIds() {
  if (unsubscribeSaved) unsubscribeSaved();

  if (!currentUser) {
    savedPostIds = new Set();
    renderFeed(); // redraw so every Save button goes back to its logged-out state
    return;
  }

  const savedRef = collection(db, "users", currentUser.uid, "savedPosts");
  unsubscribeSaved = onSnapshot(savedRef, (snapshot) => {
    // The document ID IS the post ID (see the save-toggle handler below), so
    // we don't even need to read each document's contents to build this set.
    savedPostIds = new Set(snapshot.docs.map((d) => d.id));
    renderFeed();
  });
}

// ---- Save/unsave, via event delegation. postsContainer's HTML gets fully
// rebuilt on every render (see renderFeed), which would normally wipe out
// any listeners attached directly to individual buttons - attaching ONE
// listener to the container instead sidesteps that, since it's never
// replaced itself. ----
postsContainer.addEventListener("click", async (event) => {
  const voteBtn = event.target.closest(".vote-btn");
  if (voteBtn) {
    if (!currentUser) {
      alert("Please log in to vote.");
      return;
    }
    castVote(voteBtn.dataset.postId, currentUser.uid, Number(voteBtn.dataset.direction));
    return;
  }

  const shareBtn = event.target.closest(".share-icon-btn");
  if (shareBtn) {
    const postId = shareBtn.dataset.postId;
    const match = latestPosts.find((p) => p.id === postId);
    if (match) openShareModal(postId, match.data);
    return;
  }

  const saveBtn = event.target.closest(".save-icon-btn");
  if (!saveBtn) return;

  if (!currentUser) {
    alert("Please log in to save posts.");
    return;
  }

  const postId = saveBtn.dataset.postId;
  const savedRef = doc(db, "users", currentUser.uid, "savedPosts", postId);

  if (savedPostIds.has(postId)) {
    await deleteDoc(savedRef);
  } else {
    await setDoc(savedRef, { postId, savedAt: serverTimestamp() });
  }
  // No manual re-render needed - the onSnapshot listener above will notice
  // this write, update savedPostIds, and call renderFeed() for us.
});

// ---- Initial load: honor ?topic=xyz in the URL (e.g. arriving from
// topics.html), otherwise show everything. ----
const initialTopic = new URLSearchParams(window.location.search).get("topic") || "all";
activeTopic = initialTopic;
loadFeed(initialTopic);
loadUsers();
loadTopics();
