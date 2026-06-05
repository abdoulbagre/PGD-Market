exports.handler = async (event) => {
  try {
    // Autoriser uniquement POST
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({
          error: "Méthode non autorisée"
        })
      };
    }

    // Lecture du body
    const { nom, email, produitId } = JSON.parse(event.body || "{}");

    // Validation
    if (!nom || !email || !produitId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Nom, email ou produit manquant"
        })
      };
    }

    // Produits
    const produits = [
      {
        id: 1,
        nom: "Guide Pratique du Marketing avec l’IA",
        prix:3000,
        fichier: "Guide Pratique du Marketing avec l’IA.pdf"
      },

      {
        id:2,
        nom:"Comprendre le marketing sur les réseaux sociaux",
        prix:0,
        fichier: "",
      },

      {
        id:3,
        nom:"Apprendre à rédiger un mémoire universitaire — Licence, Master, Doctorat",
        prix:0,
        fichier: "",
      },

      {
        id:4,
        nom:"2000 (Outils d’Intelligence Artificielle) IA POUR CHANGER VOTRE VIE",
        prix:0,
      },

      {
        id:5,
        nom:"GUIDE CANVA PRO GRATUIT A VIE",
        prix:0,
      },

      {
        id:6,
        nom:"Stratégies pour Générer du Trafic sur YouTube",
        prix:0,
      },

      {
        id:7,
        nom:"Créer une Application Mobile Rentable",
        prix:0,
      },

      {
        id:8,
        nom:"Apprendre les bases de la crypto-monnaie et du Trading",
        prix:0,
      },

      {
        id:9,
        nom:"Le Grand Livre des Prompts : 1000 PROMPTS pour ChatGPT",
        prix:0,
      },

      {
        id:10,
        nom:"Apprendre les bases de la monétisation Facebook – De A à Z",
        prix:0,
      }
      ];

    // Recherche du produit
    const produit = produits.find(
      (p) => p.id === Number(produitId)
    );

    if (!produit) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "Produit introuvable"
        })
      };
    }

    if (produit.prix <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Produit indisponible à la vente"
        })
      };
    }

    console.log("Produit sélectionné :", produit);

    // 🔥 FIX IMPORTANT : split nom en prénom + nom
    const cleanNom = nom.trim();
    const nameParts = cleanNom.split(" ");
    const firstName = nameParts[0] || "Client";
    const lastName = nameParts.slice(1).join(" ") || "Client";

    // Création du paiement Moneroo
    const response = await fetch(
      "https://api.moneroo.io/v1/payments/initialize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${process.env.MONEROO_SECRET_KEY}`
        },
        body: JSON.stringify({
          amount: produit.prix,
          currency: "XOF",
          description: produit.nom,

          return_url: `https://pgd-market.netlify.app/success.html?produitId=${produit.id}`,
          cancel_url: "https://pgd-market.netlify.app/cancel.html",
          callback_url: "https://pgd-market.netlify.app/.netlify/functions/webhook",

          customer: {
            first_name: firstName,
            last_name: lastName,
            email: email
          },

          metadata: {
            produitId: produit.id,
            produitNom: produit.nom
          }
        })
      }
    );

    const data = await response.json();

    console.log("MONEROO RESPONSE:", JSON.stringify(data));

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: data.message || "Erreur Moneroo",
          details: data
        })
      };
    }

    // Recherche de l'URL de paiement
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