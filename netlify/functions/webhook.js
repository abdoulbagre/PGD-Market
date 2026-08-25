const crypto = require("crypto");

const PRODUCT_CATALOG = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    nom: "monétisation TikTok – De A à Z",
    prix: 7500,
    fichier: [
      "BONUS Le secret pour transformer tes vidéos en cash.pdf",
      "PLAN 0 A 10K ABONNES EN 30 JOURS.pdf"
    ]
  },
  {
    id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
    nom: "Guide Pratique du Marketing avec l’IA",
    prix: 8500,
    fichier: "Guide Pratique du Marketing avec l’IA.pdf"
  }
];

const normalizeProductFiles = (product) => {
  if (!product) return [];
  const files = Array.isArray(product.fichier)
    ? product.fichier
    : typeof product.fichier === "string" && product.fichier.trim()
      ? [product.fichier]
      : [];
  return files.map((file) => String(file).trim()).filter(Boolean);
};

const getHeader = (headers = {}, names) => {
  const entries = Object.entries(headers || {});
  for (const [key, value] of entries) {
    if (names.includes(String(key).toLowerCase()) && value) {
      return String(value);
    }
  }
  return null;
};

const verifySignature = (rawBody, headers) => {
  const secret = process.env.MONEROO_WEBHOOK_SECRET || process.env.MONEROO_SECRET_KEY;
  if (!secret) return true;

  const signature = getHeader(headers, [
    "x-moneroo-signature",
    "moneroo-signature",
    "x-signature",
    "signature",
    "x-moneroo-webhook-signature"
  ]);

  if (!signature) return false;

  const normalized = String(signature).replace(/^sha256=/i, "").trim();
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  if (normalized.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(normalized, "hex"));
  } catch (error) {
    return false;
  }
};

const getVerifiedPayment = async (paymentId) => {
  const secret = process.env.MONEROO_SECRET_KEY;
  if (!secret || !paymentId) return null;

  const response = await fetch(`https://api.moneroo.io/v1/payments/${encodeURIComponent(paymentId)}/verify`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${secret}`
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || "Moneroo verification failed");
  }

  return payload?.data || payload || null;
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Méthode non autorisée" })
      };
    }

    const rawBody = event.body || "{}";
    const headers = event.headers || {};

    if (!process.env.MONEROO_WEBHOOK_SECRET) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "MONEROO_WEBHOOK_SECRET manquant côté serveur" })
      };
    }

    if (!verifySignature(rawBody, headers)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Signature Moneroo invalide" })
      };
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (error) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Payload Moneroo invalide" })
      };
    }

    const eventName = String(payload?.event || payload?.type || "").toLowerCase();
    const paymentPayload = payload?.data || payload?.payment || payload || {};
    const paymentId = paymentPayload?.id || payload?.paymentId || null;

    if (!paymentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Identifiant de paiement manquant" })
      };
    }

    if (eventName && eventName !== "payment.success" && !eventName.includes("success")) {
      return {
        statusCode: 200,
        body: JSON.stringify({ received: true, ignored: true, event: eventName })
      };
    }

    const verifiedPayment = await getVerifiedPayment(paymentId);
    const data = verifiedPayment || paymentPayload;
    const status = String(data?.status || "").toLowerCase();
    const productId = data?.metadata?.produitId || data?.metadata?.product_id || paymentPayload?.metadata?.produitId || null;
    const product = PRODUCT_CATALOG.find((item) => item.id === productId);

    if (!product) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Produit du paiement introuvable", productId })
      };
    }

    if (Number(data?.amount ?? 0) !== Number(product.prix)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Montant Moneroo incohérent pour le produit", expectedAmount: product.prix, receivedAmount: data?.amount })
      };
    }

    if (String(data?.currency || "XOF").toUpperCase() !== "XOF") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Devise Moneroo incohérente", expectedCurrency: "XOF", receivedCurrency: data?.currency })
      };
    }

    if (!status.includes("success") && status !== "paid") {
      return {
        statusCode: 200,
        body: JSON.stringify({ received: true, status, message: "Paiement non confirmé" })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        paymentId,
        produitId: product.id,
        status,
        message: "Paiement confirmé par Moneroo.",
        files: normalizeProductFiles(product)
      })
    };
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Erreur webhook" })
    };
  }
};