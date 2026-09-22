const $ = (selector) => document.querySelector(selector);
const form = $("#post-form");
const textInput = $("#text");
const message = $("#form-message");
const feed = $("#feed");
const publishButton = $("#publish");
const authForm = $("#auth-form");
const usernameInput = $("#username");
const passwordInput = $("#password");
const authMessage = $("#auth-message");
const authSubmit = $("#auth-submit");
const composerDialog = $("#composer-dialog");
let resumeComposer = false;
let mode = "login";
let authBusy = false;
let publishing = false;
let currentUser = null;
let authVersion = 0;
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("cyberfeed-auth") : null;
function showUser(user) {
  currentUser = user;
  $("#visitor").hidden = Boolean(user);
  $("#signed-in").hidden = !user;
  $("#nav-login").hidden = Boolean(user);
  if (user) closeAccount();
  $("#current-user").textContent = user?.username || "";
  $("#publish-label").textContent = user ? "Publish post" : "Login to publish";
  $("#text-help").textContent = user
    ? "Up to 2,000 characters. Published under your account name."
    : "Up to 2,000 characters. You can draft now and sign in to publish.";
  publishButton.disabled = publishing;
}
function openComposer() {
  if (!composerDialog.open) composerDialog.showModal();
  document.body.classList.add("composer-open");
  $("#new-post").setAttribute("aria-expanded", "true");
  textInput.focus();
}
$("#new-post").addEventListener("click", openComposer);
$("#close-composer").addEventListener("click", () => composerDialog.close());
composerDialog.addEventListener("close", () => {
  document.body.classList.remove("composer-open");
  $("#new-post").setAttribute("aria-expanded", "false");
});
function openAccount() {
  if (composerDialog.open) {
    resumeComposer = true;
    composerDialog.close();
  }
  setMode("login");
  $("#account-panel").hidden = false;
  $("#nav-login").setAttribute("aria-expanded", "true");
  $("#account-panel").scrollIntoView({ block: "start" });
  usernameInput.focus({ preventScroll: true });
}
function closeAccount() {
  $("#account-panel").hidden = true;
  $("#nav-login").setAttribute("aria-expanded", "false");
  passwordInput.value = "";
}
$("#nav-login").addEventListener("click", openAccount);
$("#close-account").addEventListener("click", () => { closeAccount(); $("#nav-login").focus(); });
async function restoreSession() {
  if (authBusy) return;
  const version = ++authVersion;
  try {
    const result = await request("/api/auth/me");
    if (version === authVersion) showUser(result.user);
  } catch (error) {
    if (version === authVersion && error.status === 401) showUser(null);
  }
}
window.addEventListener("focus", restoreSession);
if (channel) channel.onmessage = () => restoreSession();
$("#logout").addEventListener("click", async () => {
  $("#logout").disabled = true;
  authMessage.dataset.error = "false";
  authVersion++;
  try {
    await request("/api/auth/logout", {});
    authVersion++;
    showUser(null);
    passwordInput.value = "";
    authMessage.textContent = "You are signed out.";
    channel?.postMessage("auth-changed");
  } catch (error) { authMessage.dataset.error = "true"; authMessage.textContent = error.message; }
  finally { $("#logout").disabled = false; }
});

async function request(url, body) {
  let response;
  try {
    response = await fetch(url, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json", "X-CyberFeed-Request": "1" },
      body: JSON.stringify(body)
    });
  } catch { throw new Error("Could not connect. Check your connection and try again."); }
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    error.status = response.status;
    error.retryAfter = response.headers.get("Retry-After");
    throw error;
  }
  return result;
}
function setMode(nextMode) {
  mode = nextMode;
  passwordInput.value = "";
  passwordInput.autocomplete = mode === "register" ? "new-password" : "current-password";
  authSubmit.textContent = mode === "register" ? "Create account" : "Sign in";
  $("#login-mode").setAttribute("aria-pressed", String(mode === "login"));
  $("#register-mode").setAttribute("aria-pressed", String(mode === "register"));
  authMessage.textContent = "";
  authMessage.dataset.error = "false";
}
$("#login-mode").addEventListener("click", () => setMode("login"));
$("#register-mode").addEventListener("click", () => setMode("register"));
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authBusy) return;
  authBusy = true;
  authVersion++;
  authSubmit.disabled = true;
  $("#login-mode").disabled = true;
  $("#register-mode").disabled = true;
  authMessage.textContent = "";
  authMessage.dataset.error = "false";
  try {
    const result = await request(mode === "register" ? "/api/auth/register" : "/api/auth/login", { username: usernameInput.value, password: passwordInput.value });
    authVersion++;
    if (mode === "register") {
      usernameInput.value = result.user.username;
      setMode("login");
      authMessage.textContent = "Account created. Sign in to continue.";
      passwordInput.focus();
    } else {
      passwordInput.value = "";
      showUser(result.user);
      authMessage.textContent = "You are signed in.";
      channel?.postMessage("auth-changed");
      if (resumeComposer) { resumeComposer = false; openComposer(); }
    }
  } catch (error) {
    authMessage.dataset.error = "true";
    authMessage.textContent = error.message + (error.retryAfter ? " Try again in " + error.retryAfter + " seconds." : "");
    (error.message.startsWith("Password") ? passwordInput : usernameInput).focus();
  } finally {
    authBusy = false;
    authSubmit.disabled = false;
    $("#login-mode").disabled = false;
    $("#register-mode").disabled = false;
  }
});
function createPostElement(post) {
  const article = document.createElement("article"); article.className = "post";
  const header = document.createElement("div"); header.className = "post-header";
  const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.setAttribute("aria-hidden", "true"); avatar.textContent = [...post.name][0]?.toUpperCase() || "#";
  const identity = document.createElement("div");
  const author = document.createElement("h3"); author.textContent = post.name;
  const date = document.createElement("time"); date.dateTime = post.created_at; date.textContent = new Date(post.created_at).toLocaleString();
  const text = document.createElement("p"); text.textContent = post.text;
  identity.append(author, date); header.append(avatar, identity);
  article.append(header, text); return article;
}
async function loadPosts() {
  try {
    const posts = await request("/api/posts");
    $("#post-count").textContent = posts.length + (posts.length === 1 ? " POST" : " POSTS");
    feed.replaceChildren();
    if (!posts.length) {
      const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "No posts yet. Publish the first one."; feed.append(empty);
    } else [...posts].reverse().forEach((post) => feed.append(createPostElement(post)));
  } catch {
    const error = document.createElement("p"); error.className = "empty-state"; error.textContent = "Could not load posts."; feed.replaceChildren(error);
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (publishing) return;
  if (!currentUser) {
    openAccount();
    authMessage.textContent = "Sign in to publish. Your draft is kept.";
    return;
  }
  publishing = true;
  publishButton.disabled = true; message.textContent = "";
  message.dataset.error = "false";
  try {
    await request("/api/posts", { text: textInput.value });
    textInput.value = ""; message.textContent = "Post published.";
    composerDialog.close();
    authMessage.dataset.error = "false";
    authMessage.textContent = "Post published.";
    await loadPosts();
  } catch (error) {
    message.dataset.error = "true";
    if (error.status === 401) {
      authVersion++;
      showUser(null); openAccount();
      authMessage.textContent = "Sign in again to publish. Your draft is kept.";
      passwordInput.focus();
    } else {
      message.textContent = error.status ? error.message : "Could not confirm publication. Your draft is kept. Check the feed before trying again.";
    }
  }
  finally { publishing = false; publishButton.disabled = false; }
});
loadPosts();
restoreSession();
