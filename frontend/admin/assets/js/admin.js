import { setAuthenticated } from "./admin-ui.js";

const endpoint = "/.netlify/functions/auth";
const loginForm = document.querySelector("#login-form");
const recoveryRequestForm = document.querySelector("#recovery-request-form");
const newPasswordForm = document.querySelector("#new-password-form");
const sessionPanel = document.querySelector("#session-panel");
const sessionMessage = document.querySelector("#session-message");
const authMessage = document.querySelector("#auth-message");
const authTitle = document.querySelector("#auth-title");
const authDescription = document.querySelector("#auth-description");
const forgotPasswordButton = document.querySelector("#forgot-password");
const logoutButtons = [...document.querySelectorAll("#logout-button, [data-logout]")];
const authForms = [loginForm, recoveryRequestForm, newPasswordForm];
let pendingToken = "";
let pendingFlow = "";

function authFieldError(field, form) {
  const value = field.type === "password" ? field.value : field.value.trim();
  if (field.required && !value) {
    return field.id === "confirm-password"
      ? "Confirmez votre mot de passe."
      : field.type === "email"
        ? "Saisissez votre adresse e-mail."
        : "Ce champ est obligatoire.";
  }
  if (field.type === "email" && value && !field.validity.valid) {
    return "Saisissez une adresse e-mail valide.";
  }
  if (field.minLength > 0 && value.length < field.minLength) {
    return `Choisissez un mot de passe d’au moins ${field.minLength} caractères.`;
  }
  if (field.id === "confirm-password" &&
      value !== form.elements.namedItem("password").value) {
    return "Les mots de passe ne correspondent pas.";
  }
  return "";
}

function setAuthFieldError(field, message) {
  const error = field.parentElement.querySelector("[data-auth-error-for]");
  field.toggleAttribute("aria-invalid", Boolean(message));
  error.textContent = message;
  error.hidden = !message;
}

function clearAuthFieldErrors(form) {
  form.querySelectorAll("input").forEach((field) => setAuthFieldError(field, ""));
}

function validateAuthForm(form) {
  let firstInvalidField = null;
  form.querySelectorAll("input").forEach((field) => {
    const message = authFieldError(field, form);
    setAuthFieldError(field, message);
    if (message && !firstInvalidField) firstInvalidField = field;
  });
  if (firstInvalidField) {
    firstInvalidField.focus();
    return false;
  }
  return true;
}

function showMessage(message, state = "") {
  authMessage.textContent = message;
  if (state) authMessage.dataset.state = state;
  else delete authMessage.dataset.state;
}

function showForm(form) {
  for (const candidate of authForms) {
    clearAuthFieldErrors(candidate);
    candidate.hidden = candidate !== form;
  }
  sessionPanel.hidden = true;
  showMessage("");
}

function showLogin() {
  setAuthenticated(false);
  pendingToken = "";
  pendingFlow = "";
  authTitle.textContent = "Connexion administrateur";
  authDescription.textContent = "Connectez-vous avec votre compte administrateur invité.";
  showForm(loginForm);
}

function showPasswordForm(flow, token) {
  pendingFlow = flow;
  pendingToken = token;
  authTitle.textContent = flow === "recover" ? "Choisir un nouveau mot de passe" : "Finaliser votre invitation";
  authDescription.textContent = flow === "recover"
    ? "Définissez un nouveau mot de passe pour votre compte."
    : "Choisissez un mot de passe pour terminer la création de votre compte invité.";
  showForm(newPasswordForm);
}

function showSession(isAdmin) {
  setAuthenticated(isAdmin);
  loginForm.hidden = true;
  recoveryRequestForm.hidden = true;
  newPasswordForm.hidden = true;
  sessionPanel.hidden = false;
  sessionMessage.textContent = isAdmin
    ? "Session administrateur active."
    : "Ce compte est connecté, mais ne possède pas le rôle administrateur.";
  logoutButtons.forEach((button) => { button.hidden = false; });
  showMessage(isAdmin ? "Accès autorisé." : "Accès refusé : rôle administrateur absent.", isAdmin ? "success" : "error");
}

document.addEventListener("admin:session-expired", () => {
  showLogin();
  showMessage("Votre session a expiré. Connectez-vous à nouveau.", "error");
});

async function sendRequest(action, values = {}) {
  const response = await fetch(endpoint, {
    method: action === "session" ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: action === "session" ? undefined : { "Content-Type": "application/json" },
    body: action === "session" ? undefined : JSON.stringify({ action, ...values })
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Le service de connexion a renvoyé une réponse invalide.");
  }

  if (!response.ok) {
    throw new Error(result.message || "La requête n’a pas pu être traitée.");
  }
  return result;
}

async function refreshSession() {
  try {
    const result = await sendRequest("session");
    if (result.authenticated) showSession(result.isAdmin);
    else showLogin();
  } catch (error) {
    showLogin();
    showMessage(error.message || "Le service de connexion est momentanément indisponible.", "error");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateAuthForm(loginForm)) {
    showMessage("");
    return;
  }
  const button = loginForm.querySelector("button[type=submit]");
  const formData = new FormData(loginForm);
  button.disabled = true;
  showMessage("Connexion en cours…");

  try {
    const result = await sendRequest("login", {
      email: String(formData.get("email") || "").trim(),
      password: String(formData.get("password") || "")
    });
    loginForm.reset();
    showSession(result.isAdmin);
  } catch (error) {
    showMessage(error.message || "Connexion impossible. Vérifiez vos identifiants.", "error");
  } finally {
    button.disabled = false;
  }
});

forgotPasswordButton.addEventListener("click", () => {
  authTitle.textContent = "Récupérer l’accès";
  authDescription.textContent = "Un lien sera envoyé si l’adresse correspond à un compte autorisé.";
  showForm(recoveryRequestForm);
  recoveryRequestForm.querySelector("input").focus();
});

document.querySelectorAll("[data-show-login]").forEach((button) => {
  button.addEventListener("click", showLogin);
});

recoveryRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateAuthForm(recoveryRequestForm)) {
    showMessage("");
    return;
  }
  const button = recoveryRequestForm.querySelector("button[type=submit]");
  const email = String(new FormData(recoveryRequestForm).get("email") || "").trim();
  button.disabled = true;
  showMessage("Envoi de la demande…");

  try {
    const result = await sendRequest("request-recovery", { email });
    recoveryRequestForm.reset();
    showMessage(result.message, "success");
  } catch (error) {
    showMessage(error.message || "La demande ne peut pas être traitée pour le moment.", "error");
  } finally {
    button.disabled = false;
  }
});

newPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateAuthForm(newPasswordForm)) {
    showMessage("");
    return;
  }
  const button = newPasswordForm.querySelector("button[type=submit]");
  const formData = new FormData(newPasswordForm);
  const password = String(formData.get("password") || "");

  if (!pendingToken || !["recover", "accept-invite"].includes(pendingFlow)) {
    showMessage("Ce lien est invalide ou a expiré. Demandez un nouveau lien.", "error");
    return;
  }

  button.disabled = true;
  showMessage("Mise à jour du compte…");
  try {
    const result = await sendRequest(pendingFlow, { token: pendingToken, password });
    pendingToken = "";
    pendingFlow = "";
    newPasswordForm.reset();
    showLogin();
    showMessage(result.message || "Mot de passe mis à jour. Vous pouvez vous connecter.", "success");
  } catch (error) {
    showMessage(error.message || "Le lien ne peut pas être utilisé.", "error");
  } finally {
    button.disabled = false;
  }
});

authForms.forEach((form) => {
  form.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    form.querySelectorAll('input[aria-invalid="true"]').forEach((field) => {
      setAuthFieldError(field, authFieldError(field, form));
    });
  });
});

logoutButtons.forEach((logoutButton) => {
  logoutButton.addEventListener("click", async () => {
    logoutButtons.forEach((button) => { button.disabled = true; });
    showMessage("Déconnexion en cours…");
    try {
      await sendRequest("logout");
      if (typeof window.clearAdminCatalogState === "function") {
        window.clearAdminCatalogState();
      }
      showLogin();
      showMessage("Vous êtes déconnecté.", "success");
    } catch (error) {
      showMessage(error.message || "La déconnexion n’a pas abouti.", "error");
    } finally {
      logoutButtons.forEach((button) => { button.disabled = false; });
    }
  });
});

const callbackParams = new URLSearchParams(window.location.hash.slice(1));
const inviteToken = callbackParams.get("invite_token");
const recoveryToken = callbackParams.get("recovery_token");

if (inviteToken || recoveryToken) {
  const flow = inviteToken ? "accept-invite" : "recover";
  const token = inviteToken || recoveryToken;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  showPasswordForm(flow, token);
} else {
  refreshSession();
}
