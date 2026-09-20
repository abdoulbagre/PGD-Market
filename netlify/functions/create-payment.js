const crypto = require("crypto");
const { findProduct } = require("./_products");

const supportedCurrencies = new Set(["XOF", "EUR", "USD"]);
const normalizeCurrency = (currency) => {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return supportedCurrencies.has(normalized) ? normalized : "";
};

const getBaseUrl = () =>
  (process.env.URL || process.env.DEPLOY_URL || process.env.NETLIFY_URL || "").replace(/\/+$/, "");

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Méthode non autorisée" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Corps JSON invalide" });
  }

  const nom = typeof payload.nom === "string" ? payload.nom.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const produitId = typeof payload.produitId === "string" ? payload.produitId.trim() : "";
  const currency = normalizeCurrency(payload.currency);
  const phone = typeof payload.phone === "string" ? payload.phone.replace(/\D/g, "") : "";
  const phoneCountryCode = typeof payload.phoneCountryCode === "string"
    ? payload.phoneCountryCode.trim().toUpperCase()
    : "";

  if (!nom || !email || !produitId || !currency || !phone || !phoneCountryCode) {
    return jsonResponse(400, { error: "Nom, email, téléphone, pays ou produit manquant." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: "Adresse email invalide." });
  }

  if (phone.length < 6 || !/^[A-Z]{2}$/.test(phoneCountryCode)) {
    return jsonResponse(400, { error: "Numéro de téléphone ou code pays invalide." });
  }

  const produit = findProduct(produitId);
  if (!produit) {
    return jsonResponse(404, { error: "Produit introuvable." });
  }

  if (!Number.isInteger(produit.prix) || produit.prix <= 0 || !produit.fichiers.length || !produit.chariowProductId) {
    return jsonResponse(400, { error: "Produit indisponible à la vente." });
  }

  const apiKey = process.env.CHARIOW_API_KEY?.trim();
  if (!apiKey) {
    console.error("CHARIOW CHECKOUT CONFIGURATION ERROR: CHARIOW_API_KEY is missing");
    return jsonResponse(500, { error: "Le service de paiement est temporairement indisponible." });
  }

  const nameParts = nom.split(/\s+/);
  const firstName = nameParts.shift() || "Client";
  const lastName = nameParts.join(" ") || "Client";
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    console.error("CHARIOW CHECKOUT CONFIGURATION ERROR: site URL is missing");
    return jsonResponse(500, { error: "Le service de paiement est temporairement indisponible." });
  }
  const orderRef = `PGD-${crypto.randomUUID()}`;

  try {
    const response = await fetch(`${process.env.CHARIOW_API_BASE_URL || "https://api.chariow.com/v1"}/checkout`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        product_id: produit.chariowProductId,
        email,
        first_name: firstName,
        last_name: lastName,
        phone: { number: phone, country_code: phoneCountryCode },
        payment_currency: currency,
        redirect_url: `${baseUrl}/success.html`,
        custom_metadata: {
          produit_id: String(produit.id),
          order_ref: orderRef,
          currency: currency
        }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("CHARIOW CHECKOUT ERROR:", {
        status: response.status,
        message: data?.message || "Réponse HTTP inattendue"
      });
      return jsonResponse(
        response.status >= 400 && response.status < 600 ? response.status : 502,
        { error: data?.message || "Impossible d'initialiser le paiement." }
      );
    }

    const checkout = data?.data;
    if (!checkout?.payment?.checkout_url) {
      console.error("CHARIOW CHECKOUT ERROR:", {
        status: response.status,
        message: "Réponse Chariow incomplète"
      });
      return jsonResponse(502, { error: "Réponse de paiement invalide." });
    }

    return jsonResponse(200, { checkout_url: checkout.payment.checkout_url });
  } catch (error) {
    console.error("CHARIOW CHECKOUT INITIALIZATION ERROR:", {
      status: error.statusCode || 500,
      message: error.message || "Erreur réseau"
    });
    return jsonResponse(502, { error: "Le service de paiement est temporairement indisponible." });
  }
};
