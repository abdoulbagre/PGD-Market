const params = new URLSearchParams(window.location.search);
const id = params.get("id");

const p = dataSet.find(x => x.id === id);

const btn = document.querySelector(".commanderBtn");

if (btn) {
  btn.href = "Commande.html?id=" + p.id;
}

document.querySelector(".image-Produit").src = p.image;

document.querySelector(".titreProduit").textContent = p.nom;

document.querySelector(".descriptionProduit").innerHTML = p.description;

document.querySelector(".prixProduit").textContent = (p.prix * 0.35) + " F CFA";

document.querySelector(".payerBtn").dataset.nom = p.nom;

document.querySelector(".payerBtn").dataset.prix = p.prix;

document.querySelector(".payerBtn").dataset.id = p.id;




