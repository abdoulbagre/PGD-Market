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
const logoutButton = document.querySelector("#logout-button");
let pendingToken = "";
let pendingFlow = "";

function showMessage(message, state = "") {
  authMessage.textContent = message;
  if (state) authMessage.dataset.state = state;
  else delete authMessage.dataset.state;
}

function showForm(form) {
  for (const candidate of [loginForm, recoveryRequestForm, newPasswordForm]) {
    candidate.hidden = candidate !== form;
  }
  sessionPanel.hidden = true;
  showMessage("");
}

function showLogin() {
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
  loginForm.hidden = true;
  recoveryRequestForm.hidden = true;
  newPasswordForm.hidden = true;
  sessionPanel.hidden = false;
  sessionMessage.textContent = isAdmin
    ? "Session administrateur active."
    : "Ce compte est connecté, mais ne possède pas le rôle administrateur.";
  logoutButton.hidden = false;
  showMessage(isAdmin ? "Accès autorisé." : "Accès refusé : rôle administrateur absent.", isAdmin ? "success" : "error");
}

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
});

document.querySelectorAll("[data-show-login]").forEach((button) => {
  button.addEventListener("click", showLogin);
});

recoveryRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
  const button = newPasswordForm.querySelector("button[type=submit]");
  const formData = new FormData(newPasswordForm);
  const password = String(formData.get("password") || "");
  const confirmation = String(formData.get("confirm-password") || "");

  if (password !== confirmation) {
    showMessage("Les mots de passe ne correspondent pas.", "error");
    return;
  }
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

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  showMessage("Déconnexion en cours…");
  try {
    await sendRequest("logout");
    showLogin();
    showMessage("Vous êtes déconnecté.", "success");
  } catch (error) {
    showMessage(error.message || "La déconnexion n’a pas abouti.", "error");
  } finally {
    logoutButton.disabled = false;
  }
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
