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
  },
  {
    id: "3b12f1df-5232-4e7a-9f2d-8c1a6b5e4d30",
    nom: "Apprendre à rédiger un mémoire universitaire — Licence, Master, Doctorat",
    prix: 0,
    fichier: ""
  },
  {
    id: "a8d7c6b5-4e3f-42a1-b9c8-7d6e5f4a3b21",
    nom: "GUIDE CANVA PRO GRATUIT A VIE",
    prix: 0,
    fichier: ""
  },
  {
    id: "91e2d3c4-5f6a-4789-ab01-23456789cdef",
    nom: "Apprendre les bases de la crypto-monnaie et du Trading",
    prix: 0,
    fichier: ""
  }
];

const normalizeProductFiles = (product) => {
  if (!product) {
    return [];
  }

  const files = Array.isArray(product.fichier)
    ? product.fichier
    : typeof product.fichier === "string" && product.fichier.trim()
      ? [product.fichier]
      : [];

  return files
    .map((file) => String(file).trim())
    .filter(Boolean);
};

const getBaseUrl = () => process.env.URL || process.env.DEPLOY_URL || process.env.NETLIFY_URL || "http://localhost:8888";

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Méthode non autorisée" })
      };
    }

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (error) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Corps JSON invalide" })
      };
    }

    const { nom, email, produitId } = payload;

    if (!nom || !email || !produitId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Nom, email ou produit manquant" })
      };
    }

    const produit = PRODUCT_CATALOG.find((item) => item.id === produitId);

    if (!produit) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Produit introuvable" })
      };
    }

    if (produit.prix <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Produit indisponible à la vente" })
      };
    }

    const cleanNom = String(nom).trim();
    const nameParts = cleanNom.split(/\s+/);
    const firstName = nameParts[0] || "Client";
    const lastName = nameParts.slice(1).join(" ") || "Client";
    const files = normalizeProductFiles(produit);
    const baseUrl = getBaseUrl();

    const response = await fetch("https://api.moneroo.io/v1/payments/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${process.env.MONEROO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: Number(produit.prix),
        currency: "XOF",
        description: produit.nom,
        return_url: `${baseUrl}/success.html?produitId=${encodeURIComponent(produit.id)}`,
        cancel_url: `${baseUrl}/annule.html`,
        callback_url: `${baseUrl}/.netlify/functions/webhook`,
        customer: {
          first_name: firstName,
          last_name: lastName,
          email: String(email).trim()
        },
        metadata: {
          produitId: produit.id,
          produitNom: produit.nom,
          amount: Number(produit.prix),
          currency: "XOF",
          fichiers: files
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: data?.message || "Erreur Moneroo",
          details: data
        })
      };
    }

    const checkoutUrl =
      data?.data?.checkout_url ||
      data?.checkout_url ||
      data?.payment_url ||
      data?.redirect_url ||
      data?.result?.checkout_url;

    if (!checkoutUrl) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Lien de paiement introuvable",
          details: data
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        checkout_url: checkoutUrl,
        paymentId: data?.data?.id || data?.id || null
      })
    };
  } catch (error) {
    console.error("SERVER ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Erreur serveur"
      })
    };
  }
};