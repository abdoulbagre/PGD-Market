export const handler = async (event) => {
  try {

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Méthode non autorisée" })
      };
    }

    const body = JSON.parse(event.body || "{}");

    const nom = body.nom;
    const email = body.email;
    const produitId = body.produitId;

    // ✅ VALIDATION
    if (!nom || !email || !produitId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Données manquantes" })
      };
    }

    // 🔥 DATASET SERVEUR (SECURITÉ)
    const produits = {
      1: {
        nom: "Guide Pratique du Marketing avec l’IA",
        prix: 2000,
        fichier: "Guide-Marketing-IA.pdf"
      }
    };

    const produit = produits[produitId];

    if (!produit) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Produit invalide" })
      };
    }

    const prixProduit = produit.prix;
    const nomProduit = produit.nom;

    // 🚀 MONEROO
    const response = await fetch(
      "https://api.moneroo.io/v1/payments/initialize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          Authorization: `Bearer ${process.env.MONEROO_SECRET_KEY}`
        },
        body: JSON.stringify({
          amount: prixProduit,
          currency: "XOF",
          description: nomProduit,

          return_url: `https://pgd-market.netlify.app/success.html?produitId=${produitId}`,
          cancel_url: "https://pgd-market.netlify.app/annule.html",
          callback_url: "https://pgd-market.netlify.app/.netlify/functions/webhook",

          customer: {
            first_name: nom,
            last_name: "",
            email: email
          },

          metadata: {
            produitId,
            nomProduit
          }
        })
      }
    );

    const data = await response.json();

    console.log("MONEROO RESPONSE:", data);

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: data.message || "Erreur Moneroo",
          details: data
        })
      };
    }

    const checkoutUrl =
      data?.data?.checkout_url ||
      data?.checkout_url ||
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
        paymentId: data.data?.id,
        checkout_url: checkoutUrl
      })
    };

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message
      })
    };
  }
};