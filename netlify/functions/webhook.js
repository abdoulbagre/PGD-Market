const crypto = require("crypto");
const { findProduct } = require("./_products");
const { isPaymentForProduct, verifyPayment } = require("./_moneroo");

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const hasValidSignature = (rawBody, signature) => {
  const secret = process.env.MONEROO_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = String(signature).trim();
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex")
  );
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Méthode non autorisée" });
  }

  if (!process.env.MONEROO_WEBHOOK_SECRET) {
    console.error("WEBHOOK CONFIGURATION ERROR: MONEROO_WEBHOOK_SECRET manquant");
    return jsonResponse(500, { error: "Configuration webhook manquante." });
  }

  const rawBody = event.body || "";
  const signature =
    event.headers?.["x-moneroo-signature"] || event.headers?.["X-Moneroo-Signature"];
  if (!hasValidSignature(rawBody, signature)) {
    return jsonResponse(403, { error: "Signature Moneroo invalide." });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Payload Moneroo invalide." });
  }

  const eventName = payload?.event;
  if (eventName !== "payment.success") {
    return jsonResponse(200, { received: true, ignored: true, event: eventName || null });
  }

  const paymentId = payload?.data?.id;
  if (!paymentId) {
    return jsonResponse(400, { error: "Identifiant de paiement manquant." });
  }

  try {
    const payment = await verifyPayment(paymentId);
    const productId = payment?.metadata?.produitId;
    const product = findProduct(productId);
    if (!product || !isPaymentForProduct(payment, product)) {
      return jsonResponse(403, {
        received: true,
        verified: false,
        message: "Paiement Moneroo non confirmé ou incohérent."
      });
    }

    return jsonResponse(200, {
      received: true,
      verified: true,
      paymentId: payment.id,
      produitId: product.id,
      status: payment.status,
      message: "Paiement confirmé par Moneroo."
    });
  } catch (error) {
    console.error("WEBHOOK VERIFICATION ERROR:", {
      status: error.statusCode || 500,
      message: error.message || "Erreur de vérification"
    });
    return jsonResponse(403, {
      received: true,
      verified: false,
      message: "Paiement non vérifiable auprès de Moneroo."
    });
  }
};
