const id = new URLSearchParams(location.search).get("id");

const p = dataSet.find(x => x.id == id);

document.querySelector("#payerBtn").href ="Commande.html?id=" + p.id;

document.querySelector(".image-Produit").src = p.image;

document.querySelector(".titreProduit").textContent = p.nom;

document.querySelector(".descriptionProduit").innerHTML = p.description;

document.querySelector(".prixProduit").innerHTML = p.prix + " F CFA";

document.querySelector("#payerBtn").dataset.nom = p.nom;

document.querySelector("#payerBtn").dataset.prix = p.prix;

document.querySelector("#payerBtn").dataset.id = p.id;


