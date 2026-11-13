import assert from "node:assert/strict";
import test from "node:test";
import { verifyRequestOrigin } from "@netlify/identity";
import {
  AuthAccessError,
  createAuthHandler,
  requireAdmin
} from "../backend/functions/_auth.mjs";
import authHandler from "../backend/functions/auth.mjs";
import privateAuthHandler from "../backend/functions/_auth.mjs";

const adminUser = { id: "user-admin", roles: ["admin"] };
const regularUser = { id: "user-regular", roles: ["member"] };
const makeRequest = (action, values = {}, origin = "https://shop.example") =>
  new Request("https://shop.example/.netlify/functions/_auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin
    },
    body: JSON.stringify({ action, ...values })
  });

const createIdentityStub = (overrides = {}) => ({
  acceptInvite: async () => adminUser,
  getUser: async () => null,
  login: async () => adminUser,
  logout: async () => {},
  refreshSession: async () => {},
  recoverPassword: async () => adminUser,
  requestPasswordRecovery: async () => {},
  verifyRequestOrigin,
  ...overrides
});

test("requireAdmin returns 401 for anonymous and 403 for non-admin users", async () => {
  await assert.rejects(
    requireAdmin(createIdentityStub()),
    (error) => error instanceof AuthAccessError && error.status === 401
  );
  await assert.rejects(
    requireAdmin(createIdentityStub({ getUser: async () => regularUser })),
    (error) => error instanceof AuthAccessError && error.status === 403
  );
  assert.equal(await requireAdmin(createIdentityStub({ getUser: async () => adminUser })), adminUser);
});

test("requireAdmin fails closed when Identity cannot be reached", async () => {
  await assert.rejects(
    requireAdmin(createIdentityStub({ getUser: async () => { throw new Error("offline"); } })),
    (error) => error instanceof AuthAccessError && error.status === 503
  );
});

test("protected access refreshes the session before checking the user", async () => {
  let refreshed = false;
  const identity = createIdentityStub({
    getUser: async () => adminUser,
    refreshSession: async () => { refreshed = true; }
  });

  assert.equal(await requireAdmin(identity), adminUser);
  assert.equal(refreshed, true);
});

test("login and logout use Identity and return no credentials", async () => {
  let receivedPassword;
  let logoutCalled = false;
  const handler = createAuthHandler(createIdentityStub({
    login: async (_email, password) => {
      receivedPassword = password;
      return adminUser;
    },
    logout: async () => { logoutCalled = true; }
  }));

  const loginResponse = await handler(makeRequest("login", {
    email: "admin@example.test",
    password: "test-password-123"
  }));
  const loginBody = await loginResponse.text();
  assert.equal(loginResponse.status, 200);
  assert.deepEqual(JSON.parse(loginBody), { authenticated: true, isAdmin: true });
  assert.equal(loginBody.includes(receivedPassword), false);
  assert.match(loginResponse.headers.get("cache-control"), /no-store/);

  const logoutResponse = await handler(makeRequest("logout"));
  assert.equal(logoutResponse.status, 200);
  assert.equal(logoutCalled, true);
  assert.deepEqual(await logoutResponse.json(), { authenticated: false, isAdmin: false });
});

test("recovery and invitation callbacks use Identity methods without echoing tokens", async () => {
  const calls = [];
  const handler = createAuthHandler(createIdentityStub({
    recoverPassword: async (token, password) => {
      calls.push({ action: "recover", token, password });
      return adminUser;
    },
    acceptInvite: async (token, password) => {
      calls.push({ action: "invite", token, password });
      return adminUser;
    }
  }));

  const recoveryToken = "recovery-secret-token";
  const invitationToken = "invite-secret-token";
  const password = "new-password-123";
  const recoveryResponse = await handler(makeRequest("recover", { token: recoveryToken, password }));
  const inviteResponse = await handler(makeRequest("accept-invite", { token: invitationToken, password }));

  assert.equal(recoveryResponse.status, 200);
  assert.equal(inviteResponse.status, 200);
  assert.deepEqual(await recoveryResponse.clone().json(), {
    authenticated: false,
    passwordUpdated: true,
    message: "Mot de passe modifié. Connectez-vous avec votre nouveau mot de passe."
  });
  assert.deepEqual(await inviteResponse.clone().json(), {
    authenticated: false,
    passwordUpdated: true,
    message: "Invitation acceptée. Connectez-vous avec le mot de passe choisi."
  });
  assert.deepEqual(calls, [
    { action: "recover", token: recoveryToken, password },
    { action: "invite", token: invitationToken, password }
  ]);
  for (const responseBody of [await recoveryResponse.text(), await inviteResponse.text()]) {
    assert.equal(responseBody.includes(recoveryToken), false);
    assert.equal(responseBody.includes(invitationToken), false);
    assert.equal(responseBody.includes(password), false);
  }
});

test("recovery email response does not reveal whether the account exists", async () => {
  const handler = createAuthHandler(createIdentityStub());
  const response = await handler(makeRequest("request-recovery", { email: "admin@example.test" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: "Si un compte autorisé correspond à cette adresse, un lien sera envoyé."
  });
});

test("recovery service failures are not reported as successful sends", async () => {
  const handler = createAuthHandler(createIdentityStub({
    requestPasswordRecovery: async () => { throw new Error("Identity offline"); }
  }));
  const email = "admin@example.test";
  const response = await handler(makeRequest("request-recovery", { email }));
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.equal(body.includes(email), false);
  assert.equal(body.includes("Identity offline"), false);
});

test("failed token callbacks do not echo Identity errors or credentials", async () => {
  const secretToken = "one-time-token-secret";
  const secretPassword = "private-password-123";
  const handler = createAuthHandler(createIdentityStub({
    recoverPassword: async () => {
      const error = new Error(`Rejected token ${secretToken}`);
      error.status = 400;
      throw error;
    }
  }));

  const response = await handler(makeRequest("recover", {
    token: secretToken,
    password: secretPassword
  }));
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.equal(body.includes(secretToken), false);
  assert.equal(body.includes(secretPassword), false);
});

test("mutating requests reject an untrusted Origin before calling Identity", async () => {
  let loginCalled = false;
  const handler = createAuthHandler(createIdentityStub({
    login: async () => { loginCalled = true; return adminUser; }
  }));

  const response = await handler(makeRequest("login", {
    email: "admin@example.test",
    password: "test-password-123"
  }, "https://attacker.example"));

  assert.equal(response.status, 403);
  assert.equal(loginCalled, false);
  const body = await response.text();
  assert.equal(body.includes("attacker.example"), false);

  const missingOrigin = await handler(new Request("https://shop.example/.netlify/functions/_auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", email: "admin@example.test", password: "test-password-123" })
  }));
  assert.equal(missingOrigin.status, 403);
});

test("session status never grants admin to an authenticated user without the role", async () => {
  const handler = createAuthHandler(createIdentityStub({ getUser: async () => regularUser }));
  const response = await handler(new Request("https://shop.example/.netlify/functions/_auth"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, isAdmin: false });
});

test("public auth function entrypoint re-exports the internal handler", () => {
  assert.equal(authHandler, privateAuthHandler);
});

test("session status reports anonymous users without granting access", async () => {
  const handler = createAuthHandler(createIdentityStub());
  const response = await handler(new Request("https://shop.example/.netlify/functions/auth"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false, isAdmin: false });
});

test("recovery and invitation server failures do not expose tokens or passwords", async () => {
  const secretToken = "one-time-secret-token";
  const secretPassword = "private-new-password";
  const unavailable = async () => {
    const error = new Error(`Identity failed for ${secretToken} and ${secretPassword}`);
    error.status = 503;
    throw error;
  };
  const handler = createAuthHandler(createIdentityStub({
    recoverPassword: unavailable,
    acceptInvite: unavailable
  }));

  for (const action of ["recover", "accept-invite"]) {
    const response = await handler(makeRequest(action, {
      token: secretToken,
      password: secretPassword
    }));
    const body = await response.text();

    assert.equal(response.status, 503);
    assert.equal(body.includes(secretToken), false);
    assert.equal(body.includes(secretPassword), false);
    assert.equal(body.includes("Identity failed"), false);
  }
});
