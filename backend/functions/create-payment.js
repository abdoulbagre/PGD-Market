const CHARIOW_TIMEOUT_MS = 10000;
const MAX_REQUEST_BODY_LENGTH = 8192;
const CHECKOUT_GATEWAY_HOSTS = new Map([
  ["orqex", new Set(["checkout.orqex.com"])]
]);

const jsonResponse = (statusCode, code, error) => ({
  statusCode,
  headers: {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  },
  body: JSON.stringify({ code, error })
});

const readChariowProduct = async ({ apiKey, productId, fetchImpl }) => {
  const { fetchChariowProduct } = await import("../services/chariow/products.mjs");
  return fetchChariowProduct({ apiKey, productId, fetchImpl });
};

const isProductPurchasable = async (product) => {
  const { isChariowProductPurchasable } = await import("../services/chariow/public-products.mjs");
  return isChariowProductPurchasable(product);
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isSafeCheckoutUrl = (value, gateway) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const gatewayHosts = typeof gateway === "string"
      ? CHECKOUT_GATEWAY_HOSTS.get(gateway.toLowerCase())
      : undefined;
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      (
        url.hostname === "chariow.com" ||
        url.hostname.endsWith(".chariow.com") ||
        gatewayHosts?.has(url.hostname) === true
      );
  } catch {
    return false;
  }
};

exports.createPaymentHandler = ({
  productReader = readChariowProduct,
  fetchImpl = (...args) => fetch(...args),
  env = process.env,
  timeoutMs = CHARIOW_TIMEOUT_MS
} = {}) => async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, "METHOD_NOT_ALLOWED", "Méthode non autorisée.");
  }

  const requestBody = typeof event.body === "string" ? event.body : "{}";
  if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BODY_LENGTH) {
    return jsonResponse(413, "REQUEST_TOO_LARGE", "La requête est trop volumineuse.");
  }

  let payload;
  try {
    payload = JSON.parse(requestBody);
  } catch {
    return jsonResponse(400, "INVALID_JSON", "Corps JSON invalide.");
  }

  if (
    !hasExactKeys(payload, ["product_id", "email", "first_name", "last_name", "phone"]) ||
    !hasExactKeys(payload.phone, ["number", "country_code"])
  ) {
    return jsonResponse(400, "INVALID_CHECKOUT_DATA", "Les informations de commande sont incomplètes.");
  }

  const firstName = typeof payload.first_name === "string" ? payload.first_name.trim() : "";
  const lastName = typeof payload.last_name === "string" ? payload.last_name.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const productId = typeof payload.product_id === "string" ? payload.product_id.trim() : "";
  const phoneNumber = typeof payload.phone.number === "string"
    ? payload.phone.number.replace(/\D/g, "")
    : "";
  const phoneCountryCode = typeof payload.phone.country_code === "string"
    ? payload.phone.country_code.trim().toUpperCase()
    : "";

  if (
    !firstName ||
    !lastName ||
    !email ||
    productId.length > 128 ||
    !/^prd_[A-Za-z0-9_-]+$/.test(productId) ||
    !phoneNumber ||
    !phoneCountryCode
  ) {
    return jsonResponse(400, "INVALID_CHECKOUT_DATA", "Prénom, nom, email, téléphone, pays ou produit manquant.");
  }

  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, "INVALID_EMAIL", "Adresse email invalide.");
  }

  if (
    firstName.length > 50 ||
    lastName.length > 50 ||
    /[\u0000-\u001f\u007f]/.test(firstName + lastName)
  ) {
    return jsonResponse(400, "INVALID_NAME", "Le prénom ou le nom saisi est invalide.");
  }

  if (phoneNumber.length < 6 || !/^[A-Z]{2}$/.test(phoneCountryCode)) {
    return jsonResponse(400, "INVALID_PHONE", "Numéro de téléphone ou code pays invalide.");
  }

  const readApiKey = env.CHARIOW_ADMIN_API_KEY?.trim();
  if (!readApiKey) {
    console.error("CHARIOW PRODUCT VALIDATION ERROR: CHARIOW_ADMIN_API_KEY is missing");
    return jsonResponse(503, "CHARIOW_READ_UNAVAILABLE", "La vérification du produit est temporairement indisponible.");
  }

  let product;
  try {
    product = await productReader({
      apiKey: readApiKey,
      productId,
      fetchImpl
    });
  } catch (error) {
    const code = error?.code || "CHARIOW_PRODUCT_UNAVAILABLE";
    if (error?.status === 404 || code === "CHARIOW_PRODUCT_NOT_FOUND") {
      return jsonResponse(404, "PRODUCT_NOT_FOUND", "Produit introuvable.");
    }
    console.error("CHARIOW PRODUCT VALIDATION ERROR:", { code });
    return jsonResponse(503, "CHARIOW_READ_UNAVAILABLE", "La vérification du produit est temporairement indisponible.");
  }

  if (!(await isProductPurchasable(product))) {
    return jsonResponse(400, "PRODUCT_UNAVAILABLE", "Ce produit ne peut pas être commandé actuellement.");
  }
  if (product.id !== productId) {
    console.error("CHARIOW PRODUCT VALIDATION ERROR:", { code: "CHARIOW_PRODUCT_ID_MISMATCH" });
    return jsonResponse(502, "CHARIOW_INVALID_RESPONSE", "Les données du produit sont invalides.");
  }

  const checkoutApiKey = env.CHARIOW_API_KEY?.trim();
  if (!checkoutApiKey) {
    console.error("CHARIOW CHECKOUT CONFIGURATION ERROR: CHARIOW_API_KEY is missing");
    return jsonResponse(503, "CHARIOW_CHECKOUT_UNAVAILABLE", "Le service de paiement est temporairement indisponible.");
  }

  const checkoutUrl = `${(env.CHARIOW_API_BASE_URL || "https://api.chariow.com/v1").replace(/\/+$/, "")}/checkout`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(checkoutUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${checkoutApiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        product_id: product.id,
        email,
        first_name: firstName,
        last_name: lastName,
        phone: {
          number: phoneNumber,
          country_code: phoneCountryCode
        }
      })
    });

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        return jsonResponse(504, "CHARIOW_TIMEOUT", "Chariow met trop de temps à répondre. Réessayez.");
      }
      console.error("CHARIOW CHECKOUT ERROR:", { status: response.status, code: "INVALID_JSON" });
      return jsonResponse(502, "CHARIOW_INVALID_RESPONSE", "Réponse de paiement invalide.");
    }

    if (!response.ok) {
      const code = response.status === 403
        ? "CHARIOW_CHECKOUT_SCOPE_MISSING"
        : response.status === 429
          ? "CHARIOW_RATE_LIMITED"
          : "CHARIOW_CHECKOUT_FAILED";
      console.error("CHARIOW CHECKOUT ERROR:", { status: response.status, code });
      return jsonResponse(
        response.status === 422 ? 400 : response.status === 403 || response.status === 429 ? 503 : 502,
        code,
        response.status === 422
          ? "Les informations transmises ne permettent pas de préparer le paiement."
          : "Le service de paiement est temporairement indisponible."
      );
    }

    const checkout = data?.data;
    if (checkout?.step === "already_purchased") {
      return jsonResponse(
        409,
        "ALREADY_PURCHASED",
        "Chariow indique que ce produit est déjà associé à cette adresse email."
      );
    }
    if (checkout?.step === "completed") {
      return jsonResponse(
        409,
        "ALREADY_PURCHASED",
        "Chariow indique que cet achat est déjà finalisé."
      );
    }
    if (
      checkout?.step !== "payment" ||
      !isSafeCheckoutUrl(checkout.payment?.checkout_url, checkout.payment?.gateway)
    ) {
      console.error("CHARIOW CHECKOUT ERROR:", { status: response.status, code: "INVALID_RESPONSE" });
      return jsonResponse(502, "CHARIOW_INVALID_RESPONSE", "Réponse de paiement invalide.");
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "payment", checkout_url: checkout.payment.checkout_url })
    };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError";
    const code = timedOut ? "CHARIOW_TIMEOUT" : "CHARIOW_NETWORK_ERROR";
    console.error("CHARIOW CHECKOUT INITIALIZATION ERROR:", { code });
    if (timedOut) {
      return jsonResponse(504, code, "Chariow met trop de temps à répondre. Réessayez.");
    }
    return jsonResponse(502, "CHARIOW_CHECKOUT_UNAVAILABLE", "Le service de paiement est temporairement indisponible.");
  } finally {
    clearTimeout(timeout);
  }
};

exports.handler = exports.createPaymentHandler();
