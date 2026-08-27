const fs = require("fs");
const path = require("path");
const { findProduct } = require("./_products");
const { isPaymentForProduct, verifyPayment } = require("./_moneroo");

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const getPrivateFilePath = (fileName) => {
  const privateRoot = path.resolve(__dirname, "..", "..", "private-downloads");
  const requested = String(fileName || "").trim();
  if (!requested || requested !== path.basename(requested) || path.isAbsolute(requested)) {
    return null;
  }

  const filePath = path.resolve(privateRoot, requested);
  if (!filePath.startsWith(`${privateRoot}${path.sep}`)) {
    return null;
  }
  return filePath;
};

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Méthode non autorisée" });
  }

  const params = new URLSearchParams(event.rawQueryString || "");
  const paymentId = params.get("paymentId") || event.queryStringParameters?.paymentId || "";
  const produitId = params.get("produitId") || event.queryStringParameters?.produitId || "";
  const fileName = params.get("file") || event.queryStringParameters?.file || "";

  if (!paymentId || !produitId || !fileName) {
    return jsonResponse(400, { error: "paymentId, produitId et file sont requis." });
  }

  const product = findProduct(produitId);
  if (!product) {
    return jsonResponse(404, { error: "Produit introuvable." });
  }

  if (!product.fichiers.includes(fileName)) {
    return jsonResponse(403, { authorized: false, error: "Fichier non autorisé pour ce produit." });
  }

  const filePath = getPrivateFilePath(fileName);
  if (!filePath || !fs.existsSync(filePath)) {
    return jsonResponse(404, { error: "Fichier introuvable." });
  }

  try {
    const payment = await verifyPayment(paymentId);
    if (!isPaymentForProduct(payment, product)) {
      return jsonResponse(403, {
        authorized: false,
        message: "Paiement non confirmé ou incohérent."
      });
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
    console.error("DOWNLOAD ERROR:", {
      status: error.statusCode || 500,
      message: error.message || "Erreur de vérification"
    });
    return jsonResponse(403, {
      authorized: false,
      message: "Paiement non vérifiable auprès de Moneroo."
    });
  }
};
