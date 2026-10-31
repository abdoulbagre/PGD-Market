import {
  acceptInvite,
  getUser,
  login,
  logout,
  refreshSession,
  recoverPassword,
  requestPasswordRecovery,
  verifyRequestOrigin
} from "@netlify/identity";

const identity = {
  acceptInvite,
  getUser,
  login,
  logout,
  refreshSession,
  recoverPassword,
  requestPasswordRecovery,
  verifyRequestOrigin
};

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};

export class AuthAccessError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "AuthAccessError";
    this.status = status;
    this.code = code;
  }
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isText = (value, maxLength) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  value.trim() === value;

const hasAdminRole = (user) =>
  Array.isArray(user?.roles) && user.roles.includes("admin");

const getCurrentUser = async (identityApi) => {
  if (typeof identityApi.refreshSession === "function") {
    await identityApi.refreshSession();
  }
  return identityApi.getUser();
};

export async function requireAdmin(identityApi = identity) {
  let user;
  try {
    user = await getCurrentUser(identityApi);
  } catch {
    throw new AuthAccessError(503, "AUTH_UNAVAILABLE");
  }

  if (!user) throw new AuthAccessError(401, "AUTHENTICATION_REQUIRED");
  if (!hasAdminRole(user)) throw new AuthAccessError(403, "ADMIN_ROLE_REQUIRED");
  return user;
}

const sessionResult = (user) => ({
  authenticated: Boolean(user),
  isAdmin: hasAdminRole(user)
});

const parseJson = async (request) => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new AuthAccessError(415, "UNSUPPORTED_CONTENT_TYPE");
  }

  const body = await request.text();
  if (body.length > 8192) throw new AuthAccessError(413, "REQUEST_TOO_LARGE");

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new AuthAccessError(400, "INVALID_REQUEST");
  }

  if (!isRecord(payload)) throw new AuthAccessError(400, "INVALID_REQUEST");
  return payload;
};

const errorResponse = (error, action) => {
  if (error instanceof AuthAccessError) {
    const messages = {
      AUTHENTICATION_REQUIRED: "Connectez-vous pour continuer.",
      ADMIN_ROLE_REQUIRED: "Ce compte n’a pas les droits d’administration.",
      ORIGIN_FORBIDDEN: "Cette requête n’est pas autorisée.",
      UNSUPPORTED_CONTENT_TYPE: "Format de requête non pris en charge.",
      REQUEST_TOO_LARGE: "La requête est trop volumineuse.",
      INVALID_REQUEST: "Les informations envoyées sont invalides.",
      AUTH_UNAVAILABLE: "Le service de connexion est momentanément indisponible."
    };
    return jsonResponse(error.status, {
      error: error.code,
      message: messages[error.code] || "La requête n’a pas pu être traitée."
    });
  }

  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (status === 403) {
    return jsonResponse(403, {
      error: "ORIGIN_FORBIDDEN",
      message: "Cette requête n’est pas autorisée."
    });
  }

  if (action === "login" && (status === 400 || status === 401)) {
    return jsonResponse(401, {
      error: "LOGIN_FAILED",
      message: "Adresse e-mail ou mot de passe incorrect."
    });
  }

  if (action === "recover" || action === "accept-invite") {
    if (status === 400 || status === 401 || status === 404 || status === 422) {
      return jsonResponse(400, {
        error: "TOKEN_INVALID",
        message: "Ce lien est invalide ou a expiré. Demandez un nouveau lien."
      });
    }
  }

  if (action === "request-recovery") {
    if (status === 0 || status >= 500) {
      return jsonResponse(503, {
        error: "AUTH_UNAVAILABLE",
        message: "Le service de récupération est momentanément indisponible."
      });
    }
    return jsonResponse(200, {
      message: "Si un compte autorisé correspond à cette adresse, un lien sera envoyé."
    });
  }

  return jsonResponse(503, {
    error: "AUTH_UNAVAILABLE",
    message: "Le service de connexion est momentanément indisponible."
  });
};

export function createAuthHandler(identityApi = identity) {
  return async function authHandler(request) {
    if (request.method === "GET") {
      try {
        return jsonResponse(200, sessionResult(await getCurrentUser(identityApi)));
      } catch {
        return jsonResponse(503, {
          error: "AUTH_UNAVAILABLE",
          message: "Le service de connexion est momentanément indisponible."
        });
      }
    }

    if (request.method !== "POST") {
      return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
    }

    let action;
    try {
      identityApi.verifyRequestOrigin(request);
      const payload = await parseJson(request);
      action = payload.action;

      if (action === "login") {
        if (!isText(payload.email, 320) || !isText(payload.password, 1024)) {
          throw new AuthAccessError(400, "INVALID_REQUEST");
        }
        const user = await identityApi.login(payload.email, payload.password);
        return jsonResponse(200, sessionResult(user));
      }

      if (action === "logout") {
        await identityApi.logout();
        return jsonResponse(200, { authenticated: false, isAdmin: false });
      }

      if (action === "request-recovery") {
        if (!isText(payload.email, 320)) throw new AuthAccessError(400, "INVALID_REQUEST");
        await identityApi.requestPasswordRecovery(payload.email);
        return jsonResponse(200, {
          message: "Si un compte autorisé correspond à cette adresse, un lien sera envoyé."
        });
      }

      if (action === "recover" || action === "accept-invite") {
        if (
          !isText(payload.token, 4096) ||
          !isText(payload.password, 1024) ||
          payload.password.length < 8
        ) {
          throw new AuthAccessError(400, "INVALID_REQUEST");
        }

        if (action === "recover") {
          await identityApi.recoverPassword(payload.token, payload.password);
          return jsonResponse(200, {
            authenticated: false,
            passwordUpdated: true,
            message: "Mot de passe modifié. Connectez-vous avec votre nouveau mot de passe."
          });
        }

        await identityApi.acceptInvite(payload.token, payload.password);
        return jsonResponse(200, {
          authenticated: false,
          passwordUpdated: true,
          message: "Invitation acceptée. Connectez-vous avec le mot de passe choisi."
        });
      }

      throw new AuthAccessError(400, "INVALID_REQUEST");
    } catch (error) {
      return errorResponse(error, action);
    }
  };
}

export default createAuthHandler();
