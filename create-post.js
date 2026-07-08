// ============================================
// CREATE POST LOGIC
// ============================================

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, addDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Cloudinary config ----
// These two values aren't secret (same idea as the Firebase config) - an
// UNSIGNED upload preset is specifically designed to be called straight from
// browser JS with no hidden key involved. The preset itself (configured on
// Cloudinary's dashboard) is what controls what's allowed to be uploaded.
const CLOUD_NAME = "ih1nbkry";
const UPLOAD_PRESET = "clook_uploads";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

const form = document.getElementById("post-form");
const errorBox = document.getElementById("error-box");
const submitBtn = document.getElementById("submit-btn");
const topicSelect = document.getElementById("topic");
const mediaInput = document.getElementById("media");
const fileHint = document.getElementById("file-hint");
const mediaPreview = document.getElementById("media-preview");

// Same defaults as feed.js - kept in sync with whatever's actually in the
// "topics" collection there. Duplicating this small list here (rather than
// importing it) keeps each page's JS standalone, matching the rest of the app.
const DEFAULT_TOPICS = ["general", "webdev", "gaming", "music", "askanything"];

// We need to know WHO is posting. If nobody's logged in, send them to the login page
// instead of letting them submit a post with no author.
let currentUser = null;

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
  } else {
    // Not logged in — no point showing this page at all
    window.location.href = "login.html";
  }
});

// ---- Keeps the topic dropdown in sync with Firestore in real time, so a
// topic someone just created on the home page shows up here without a
// refresh - same live pattern as everything else in this app. ----
onSnapshot(collection(db, "topics"), (snapshot) => {
  const customTopics = snapshot.docs.map((d) => d.id);
  const merged = Array.from(new Set([...DEFAULT_TOPICS, ...customTopics])).sort();

  // Remember whatever was selected so re-populating the list (which happens
  // every time Firestore sends an update) doesn't reset the user's choice.
  const previousValue = topicSelect.value;

  topicSelect.innerHTML = `<option value="" disabled${previousValue ? "" : " selected"}>Choose a topic...</option>` +
    merged.map((topic) => `<option value="${topic}">#${topic}</option>`).join("");

  if (merged.includes(previousValue)) {
    topicSelect.value = previousValue;
  }
});

// ---- Runs the moment someone picks a file, so they find out about a size
// problem immediately - not after typing a whole post and hitting submit. ----
mediaInput.addEventListener("change", () => {
  const file = mediaInput.files[0];
  mediaPreview.innerHTML = "";
  fileHint.textContent = "";
  fileHint.classList.remove("file-hint--error");

  if (!file) return;

  if (file.size > MAX_FILE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    fileHint.textContent = `That file is ${sizeMB}MB — the max is 25MB. Please choose a smaller file.`;
    fileHint.classList.add("file-hint--error");
    mediaInput.value = ""; // clears the picked file so it can't be submitted
    return;
  }

  // Show a quick local preview. URL.createObjectURL() makes a temporary
  // browser-only link to the file sitting on the user's computer - nothing
  // gets uploaded anywhere yet, this is purely a "does this look right?" check.
  const previewUrl = URL.createObjectURL(file);
  if (file.type.startsWith("image/")) {
    mediaPreview.innerHTML = `<img src="${previewUrl}" class="media-preview-img" alt="Preview" />`;
  } else if (file.type.startsWith("video/")) {
    mediaPreview.innerHTML = `<video src="${previewUrl}" class="media-preview-img" controls></video>`;
  }

  fileHint.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)}MB)`;
});

// ---- Uploads the file straight to Cloudinary from the browser and returns
// { url, type } for whatever came back. "auto" in the endpoint URL lets
// Cloudinary figure out image vs video on its own. ----
async function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", UPLOAD_PRESET);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error("Upload failed");
  }

  const data = await response.json();
  return {
    url: data.secure_url,
    type: data.resource_type // "image" or "video"
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  // Safety check in case this fires before onAuthStateChanged finishes
  if (!currentUser) {
    errorBox.textContent = "You need to be logged in to post.";
    errorBox.style.display = "block";
    return;
  }

  const topic = topicSelect.value;
  const title = document.getElementById("title").value.trim();
  const body = document.getElementById("body").value.trim();
  const file = mediaInput.files[0]; // undefined if nothing was picked

  // Disable the button while saving, so people can't double-submit by clicking twice
  submitBtn.disabled = true;
  submitBtn.textContent = file ? "Uploading..." : "Posting...";

  try {
    // If a file was picked, upload it FIRST - we need the resulting URL
    // before we can save the post at all.
    let media = null;
    if (file) {
      media = await uploadToCloudinary(file);
      submitBtn.textContent = "Posting...";
    }

    // addDoc() creates a new document with an auto-generated ID inside the "posts" collection.
    await addDoc(collection(db, "posts"), {
      topic: topic,
      title: title,
      body: body,
      authorId: currentUser.uid,
      authorName: currentUser.displayName || currentUser.email,
      votes: 0,
      commentCount: 0,
      archived: false, // lets a post be hidden from the feed later without deleting it
      mediaUrl: media ? media.url : null,
      mediaType: media ? media.type : null,
      createdAt: serverTimestamp()
    });

    // Success -> back to the homepage to see it in the feed
    window.location.href = "index.html";

  } catch (error) {
    errorBox.textContent = file
      ? "Something went wrong uploading your file or saving your post. Please try again."
      : "Something went wrong saving your post. Please try again.";
    errorBox.style.display = "block";
    submitBtn.disabled = false;
    submitBtn.textContent = "Post it";
  }
});
