const products = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    nom: "monétisation TikTok – De A à Z",
    prix: 6900,
    fichiers: [
      "BONUS Le secret pour transformer tes vidéos en cash.pdf",
      "PLAN 0 A 10K ABONNES EN 30 JOURS.pdf"
    ]
  },
  {
    id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
    nom: "Guide Pratique du Marketing avec l’IA",
    prix: 4800,
    fichiers: ["Guide Pratique du Marketing avec l’IA.pdf"]
  }
];

const findProduct = (id) => products.find((product) => product.id === id);

module.exports = { products, findProduct };
