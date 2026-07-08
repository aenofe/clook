// ============================================
// ALL TOPICS PAGE
// Lists every topic (defaults + anything users have created), grouped by
// starting letter, laid out in a 3-column grid (A/D/G... left, B/E/H...
// center, C/F/I... right) via CSS Grid - see .topics-columns in style.css.
// Grid auto-sizes each row to its tallest cell, so C's row lines up with
// A's and B's even if C has more (or fewer) topics in it.
// Clicking a topic takes you to the home feed filtered to it.
// ============================================

import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const listContainer = document.getElementById("all-topics-list");

// Same defaults as feed.js/create-post.js - each page keeps its own copy so
// every page's JS stays standalone (same pattern used throughout this app).
const DEFAULT_TOPICS = ["general", "webdev", "gaming", "music", "askanything"];

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Splits an alphabetically-sorted topic list into per-letter groups, e.g.
// A -> ["askanything"], C -> ["chemistry", "computer"]. Only letters that
// actually have at least one topic show up. A Map (not a plain object)
// keeps insertion order, and topics arrive pre-sorted, so the letters come
// out in A-Z order for free.
function groupByLetter(topics) {
  const groups = new Map();
  topics.forEach((topic) => {
    const letter = topic[0].toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(topic);
  });
  return groups;
}

// Renders every letter group IN ORDER (A, B, C, D...) as siblings. The
// 3-column split happens purely in CSS (grid-template-columns + auto-flow),
// which is what lets the grid keep row 1 (A/B/C) and row 2 (D/E/F) aligned
// even when, say, C has way more topics than A or B.
function buildGridHtml(groups) {
  return Array.from(groups.entries())
    .map(([letter, topics]) => {
      const topicsHtml = topics
        .map((topic) => `<a href="index.html?topic=${encodeURIComponent(topic)}" class="topic-tag">#${escapeHtml(topic)}</a>`)
        .join("");
      return `
        <div class="topics-letter-group">
          <h2 class="topics-letter-heading">${letter}</h2>
          <div class="topics-letter-topics">${topicsHtml}</div>
        </div>
      `;
    })
    .join("");
}

onSnapshot(collection(db, "topics"), (snapshot) => {
  const customTopics = snapshot.docs.map((d) => d.id);

  // Merge defaults + custom, drop duplicates, and sort alphabetically -
  // needed both for the final look AND so groupByLetter() gets clean input.
  const allTopics = Array.from(new Set([...DEFAULT_TOPICS, ...customTopics])).sort();

  if (allTopics.length === 0) {
    listContainer.innerHTML = `<p class="feed-empty">No topics yet.</p>`;
    return;
  }

  const groups = groupByLetter(allTopics);
  listContainer.innerHTML = `<div class="topics-columns">${buildGridHtml(groups)}</div>`;
}, (error) => {
  console.error("Topics load error:", error);
  listContainer.innerHTML = `<p class="feed-empty">Couldn't load topics. Check the console for details.</p>`;
});
