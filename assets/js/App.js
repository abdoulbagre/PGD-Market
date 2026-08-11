const c=document.getElementById("produits");
function afficher(l){c.innerHTML="";l.forEach(p=>{
c.innerHTML+=
`<div class="produit"> 
      <a class="btn-download" href="${p.image}" download>
      </a>  
      <a href="Detail_produit.html?id=${p.id}" >
        <img class="image-Produit" src=${p.image}>
      </a>  
      
      <h3>${p.nom}</h3>
      <p class="prixProduit">
        <span class="old-price">${p.prix} F CFA</span>
        <span class="new-price">${p.prix * 0.6} F CFA</span>
      </p>
      <a class="detailBtn" href="Detail_produit.html?id=${p.id}">voir les détails → </a>
  </div>`})
}


afficher(dataSet);


// === AJOUT FILTRES (nom, catégorie, prix) ===
const searchInput=document.getElementById("searchInput");
const categoryFilter=document.getElementById("categoryFilter");
const priceFilter=document.getElementById("priceFilter");

function filtrerProduits(){
  let r=[...dataSet];

  if(searchInput && searchInput.value.trim()!==""){
    const q=searchInput.value.toLowerCase();
    r=r.filter(p=>p.nom.toLowerCase().includes(q));
  }

  if(categoryFilter && categoryFilter.value!==""){
    r=r.filter(p=>p.categorie===categoryFilter.value);
  }

  if(priceFilter && priceFilter.value!==""){
    const v=priceFilter.value.split("-");
    const min=parseInt(v[0]);
    const max=parseInt(v[1]);
    r=r.filter(p=>p.prix>=min && p.prix<=max);
  }

  afficher(r);
}

if(searchInput) searchInput.addEventListener("input",filtrerProduits);
if(categoryFilter) categoryFilter.addEventListener("change",filtrerProduits);
if(priceFilter) priceFilter.addEventListener("change",filtrerProduits);
