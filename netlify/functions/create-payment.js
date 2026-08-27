const { findProduct } = require("./_products");

const getBaseUrl = () =>
  process.env.URL || process.env.DEPLOY_URL || process.env.NETLIFY_URL || "http://localhost:8888";

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

  if (!nom || !email || !produitId) {
    return jsonResponse(400, { error: "Nom, email ou produit manquant." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: "Adresse email invalide." });
  }

  const produit = findProduct(produitId);
  if (!produit) {
    return jsonResponse(404, { error: "Produit introuvable." });
  }

  if (!Number.isInteger(produit.prix) || produit.prix <= 0 || !produit.fichiers.length) {
    return jsonResponse(400, { error: "Produit indisponible à la vente." });
  }

  const nameParts = nom.split(/\s+/);
  const firstName = nameParts.shift() || "Client";
  const lastName = nameParts.join(" ") || "Client";
  const baseUrl = getBaseUrl();

  try {
    const response = await fetch("https://api.moneroo.io/v1/payments/initialize", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MONEROO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: produit.prix,
        currency: "XOF",
        description: produit.nom,
        return_url: `${baseUrl}/success.html?produitId=${encodeURIComponent(produit.id)}`,
        customer: {
          first_name: firstName,
          last_name: lastName,
          email
        },
        metadata: {
          produitId: String(produit.id),
          produitNom: String(produit.nom),
          amount: String(produit.prix),
          currency: "XOF"
        }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (response.status !== 201) {
      console.error("MONEROO INITIALIZE ERROR:", {
        status: response.status,
        message: data?.message || "Réponse HTTP inattendue"
      });
      return jsonResponse(
        response.status >= 400 && response.status < 600 ? response.status : 502,
        { error: data?.message || "Impossible d'initialiser le paiement." }
      );
    }

    const payment = data?.data;
    if (!payment?.checkout_url || !payment?.id) {
      console.error("MONEROO INITIALIZE ERROR:", {
        status: response.status,
        message: "Réponse Moneroo incomplète"
      });
      return jsonResponse(502, { error: "Réponse de paiement invalide." });
    }

    return jsonResponse(200, {
      success: true,
      checkout_url: payment.checkout_url,
      paymentId: payment.id
    });
  } catch (error) {
    console.error("PAYMENT INITIALIZATION ERROR:", {
      status: error.statusCode || 500,
      message: error.message || "Erreur réseau"
    });
    return jsonResponse(502, { error: "Le service de paiement est temporairement indisponible." });
  }
};
