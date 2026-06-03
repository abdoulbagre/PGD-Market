const boutons = document.querySelectorAll(".payerBtn");

let isProcessing = false;

boutons.forEach((bouton) => {
  bouton.addEventListener("click", async () => {
    if (isProcessing) return;
    isProcessing = true;

    const ancienTexte = bouton.innerText;

    // sauvegarde état initial
    bouton.disabled = true;
    bouton.innerText = "Chargement...";

    try {
      const nomProduit = bouton.dataset.nom?.trim();
      const produitId = bouton.dataset.id;

      const nom = document.getElementById("nom").value.trim();
      const email = document.getElementById("email").value.trim();

      // ✅ VALIDATION INPUT
      if (!nom || !email) {
        alert("Veuillez remplir votre nom et email");
        return;
      }

      if (!nomProduit || !produitId) {
        alert("Produit invalide");
        return;
      }

      const response = await fetch("/.netlify/functions/create-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nom,
          email,
          produitId
        })
      });

      const data = await response.json();

      console.log("API RESPONSE:", data);

      if (!response.ok) {
        throw new Error(data.error || "Erreur serveur Netlify");
      }

      const redirectUrl =
        data.checkout_url ||
        data.payment_url ||
        data.redirect_url ||
        data.invoice_url ||
        data?.data?.checkout_url;

      if (!redirectUrl) {
        console.error("Réponse complète :", data);
        throw new Error("Lien de paiement introuvable");
      }

      // Redirection paiement
      window.location.href = redirectUrl;

    } catch (error) {
      console.error("PAYMENT ERROR:", error);

      bouton.innerText = "❌ Erreur paiement";

      setTimeout(() => {
        bouton.innerText = ancienTexte;
      }, 2000);

    } finally {
      // 🔥 toujours reset proprement
      bouton.disabled = false;
      isProcessing = false;
    }
  });
});