const crypto = require("crypto");

const PAYMENT_CURRENCY = "XOF";
const CHECKOUT_SUPPORTED_TYPES = new Set(["downloadable", "course", "license", "bundle"]);
const getBaseUrl = (env) =>
  (env.URL || env.DEPLOY_URL || env.NETLIFY_URL || "").replace(/\/+$/, "");

const jsonResponse = (statusCode, code, error) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, error })
});

const readChariowProduct = async ({ apiKey, productId, fetchImpl }) => {
  const { fetchChariowProduct } = await import("../services/chariow/products.mjs");
  return fetchChariowProduct({ apiKey, productId, fetchImpl });
};

const isProductPurchasable = (product) => {
  const price = product?.pricing?.current_price;
  const remaining = product?.quantity?.remaining?.value;
  return product?.status === "published" &&
    CHECKOUT_SUPPORTED_TYPES.has(product.type) &&
    product.has_variant_pricing !== true &&
    product.is_free !== true &&
    !["free", "what_you_want"].includes(product.pricing?.type) &&
    typeof price?.value === "number" &&
    Number.isFinite(price.value) &&
    price.value > 0 &&
    typeof price.currency === "string" &&
    /^[A-Z]{3}$/.test(price.currency) &&
    !(Number.isSafeInteger(remaining) && remaining <= 0);
};

const isSafeCheckoutUrl = (value) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      (url.hostname === "chariow.com" || url.hostname.endsWith(".chariow.com"));
  } catch {
    return false;
  }
};

exports.createPaymentHandler = ({
  productReader = readChariowProduct,
  fetchImpl = (...args) => fetch(...args),
  env = process.env
} = {}) => async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, "METHOD_NOT_ALLOWED", "Méthode non autorisée.");
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, "INVALID_JSON", "Corps JSON invalide.");
  }

  const nom = typeof payload.nom === "string" ? payload.nom.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const produitId = typeof payload.produitId === "string" ? payload.produitId.trim() : "";
  const phone = typeof payload.phone === "string" ? payload.phone.replace(/\D/g, "") : "";
  const phoneCountryCode = typeof payload.phoneCountryCode === "string"
    ? payload.phoneCountryCode.trim().toUpperCase()
    : "";

  if (
    !nom ||
    !email ||
    produitId.length > 128 ||
    !/^prd_[A-Za-z0-9_-]+$/.test(produitId) ||
    !phone ||
    !phoneCountryCode
  ) {
    return jsonResponse(400, "INVALID_CHECKOUT_DATA", "Nom, email, téléphone, pays ou produit manquant.");
  }

  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, "INVALID_EMAIL", "Adresse email invalide.");
  }

  if (phone.length < 6 || !/^[A-Z]{2}$/.test(phoneCountryCode)) {
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
      productId: produitId,
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

  if (!isProductPurchasable(product)) {
    return jsonResponse(400, "PRODUCT_UNAVAILABLE", "Ce produit ne peut pas être commandé actuellement.");
  }
  if (product.id !== produitId) {
    console.error("CHARIOW PRODUCT VALIDATION ERROR:", { code: "CHARIOW_PRODUCT_ID_MISMATCH" });
    return jsonResponse(502, "CHARIOW_INVALID_RESPONSE", "Les données du produit sont invalides.");
  }

  const checkoutApiKey = env.CHARIOW_API_KEY?.trim();
  if (!checkoutApiKey) {
    console.error("CHARIOW CHECKOUT CONFIGURATION ERROR: CHARIOW_API_KEY is missing");
    return jsonResponse(503, "CHARIOW_CHECKOUT_UNAVAILABLE", "Le service de paiement est temporairement indisponible.");
  }

  const nameParts = nom.split(/\s+/);
  const firstName = nameParts.shift() || "Client";
  const lastName = nameParts.join(" ") || "Client";
  if (firstName.length > 50 || lastName.length > 50) {
    return jsonResponse(400, "INVALID_NAME", "Le nom saisi est trop long.");
  }

  const baseUrl = getBaseUrl(env);
  if (!baseUrl) {
    console.error("CHARIOW CHECKOUT CONFIGURATION ERROR: site URL is missing");
    return jsonResponse(503, "CHARIOW_CHECKOUT_UNAVAILABLE", "Le service de paiement est temporairement indisponible.");
  }
  const orderRef = `PGD-${crypto.randomUUID()}`;
  const checkoutUrl = `${(env.CHARIOW_API_BASE_URL || "https://api.chariow.com/v1").replace(/\/+$/, "")}/checkout`;

  try {
    const response = await fetchImpl(checkoutUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${checkoutApiKey}`
      },
      body: JSON.stringify({
        product_id: product.id,
        email,
        first_name: firstName,
        last_name: lastName,
        phone: { number: phone, country_code: phoneCountryCode },
        payment_currency: PAYMENT_CURRENCY,
        redirect_url: `${baseUrl}/success.html`,
        custom_metadata: {
          produit_id: String(product.id),
          order_ref: orderRef,
          currency: PAYMENT_CURRENCY
        }
      })
    });

    let data;
    try {
      data = await response.json();
    } catch {
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
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" })
      };
    }
    if (checkout?.step !== "payment" || !isSafeCheckoutUrl(checkout.payment?.checkout_url)) {
      console.error("CHARIOW CHECKOUT ERROR:", { status: response.status, code: "INVALID_RESPONSE" });
      return jsonResponse(502, "CHARIOW_INVALID_RESPONSE", "Réponse de paiement invalide.");
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "payment", checkout_url: checkout.payment.checkout_url })
    };
  } catch (error) {
    console.error("CHARIOW CHECKOUT INITIALIZATION ERROR:", {
      code: error?.name === "AbortError" ? "CHARIOW_TIMEOUT" : "CHARIOW_NETWORK_ERROR"
    });
    return jsonResponse(502, "CHARIOW_CHECKOUT_UNAVAILABLE", "Le service de paiement est temporairement indisponible.");
  }
};

exports.handler = exports.createPaymentHandler();
