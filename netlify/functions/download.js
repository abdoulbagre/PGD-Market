const fs = require("fs");
const path = require("path");

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

const safeJoinDownloads = (requestedFile) => {
  const downloadsRoot = path.resolve(__dirname, "..", "..", "assets", "downloads");
  const candidate = path.basename(String(requestedFile || "").trim());
  if (!candidate) return null;
  const fullPath = path.join(downloadsRoot, candidate);
  const normalizedRoot = path.resolve(downloadsRoot);
  const normalizedFile = path.resolve(fullPath);
  if (!normalizedFile.startsWith(normalizedRoot + path.sep) && normalizedFile !== normalizedRoot) {
    return null;
  }
  return normalizedFile;
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Méthode non autorisée" })
      };
    }

    const params = new URLSearchParams(event.rawQueryString || event.queryStringParameters ? (event.rawQueryString || Object.entries(event.queryStringParameters || {}).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")) : "");
    const paymentId = params.get("paymentId");
    const produitId = params.get("produitId");
    const requestedFile = params.get("file");

    if (!paymentId || !produitId || !requestedFile) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "paymentId, produitId et file sont requis" })
      };
    }

    const product = PRODUCT_CATALOG.find((item) => item.id === produitId);
    if (!product) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Produit introuvable" })
      };
    }

    const allowedFiles = normalizeProductFiles(product);
    const fileName = String(requestedFile).trim();
    if (!allowedFiles.includes(fileName)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Fichier non autorisé pour ce produit" })
      };
    }

    const verifiedPayment = await getVerifiedPayment(paymentId);
    if (!verifiedPayment) {
      return {
        statusCode: 403,
        body: JSON.stringify({ authorized: false, message: "Paiement non vérifiable auprès de Moneroo" })
      };
    }

    const status = String(verifiedPayment?.status || "").toLowerCase();
    const amount = Number(verifiedPayment?.amount ?? 0);
    const currency = String(verifiedPayment?.currency || "XOF").toUpperCase();
    const metadata = verifiedPayment?.metadata || {};
    const realProductId = metadata?.produitId || metadata?.product_id || null;

    if (!status.includes("success") && status !== "paid") {
      return {
        statusCode: 403,
        body: JSON.stringify({ authorized: false, message: "Paiement non confirmé", status })
      };
    }

    if (amount !== Number(product.prix)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ authorized: false, message: "Montant incohérent pour ce produit" })
      };
    }

    if (currency !== "XOF") {
      return {
        statusCode: 403,
        body: JSON.stringify({ authorized: false, message: "Devise invalide" })
      };
    }

    if (realProductId && realProductId !== produitId) {
      return {
        statusCode: 403,
        body: JSON.stringify({ authorized: false, message: "Produit incohérent avec le paiement" })
      };
    }

    const filePath = safeJoinDownloads(fileName);
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Fichier introuvable" })
      };
    }

    const buffer = fs.readFileSync(filePath);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
        "Cache-Control": "no-store"
      },
      isBase64Encoded: true,
      body: buffer.toString("base64")
    };
  } catch (error) {
    console.error("DOWNLOAD ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Erreur de téléchargement" })
    };
  }
};
