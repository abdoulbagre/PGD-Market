const { findProduct } = require("./_products");
const { isPaymentForProduct, verifyPayment } = require("./_moneroo");

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Méthode non autorisée" });
  }

  const params = new URLSearchParams(event.rawQueryString || "");
  const paymentId = params.get("paymentId") || event.queryStringParameters?.paymentId || "";
  const produitId = params.get("produitId") || event.queryStringParameters?.produitId || "";

  if (!paymentId || !produitId) {
    return jsonResponse(400, { error: "paymentId et produitId sont requis." });
  }

  const product = findProduct(produitId);
  if (!product) {
    return jsonResponse(404, { error: "Produit introuvable." });
  }

  try {
    const payment = await verifyPayment(paymentId);
    if (!isPaymentForProduct(payment, product)) {
      return jsonResponse(403, {
        authorized: false,
        message: "Paiement non confirmé ou incohérent."
      });
    }

    return jsonResponse(200, {
      authorized: true,
      paymentId,
      produitId: product.id,
      status: payment.status,
      files: product.fichiers
    });
  } catch (error) {
    console.error("CHECK ACCESS ERROR:", {
      status: error.statusCode || 500,
      message: error.message || "Erreur de vérification"
    });
    return jsonResponse(403, {
      authorized: false,
      message: "Paiement non vérifiable auprès de Moneroo."
    });
  }
};
