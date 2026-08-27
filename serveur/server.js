const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 5000;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer((req, res) => {
    try {
        let urlPath = decodeURIComponent(req.url.split("?")[0]);

        if (urlPath === "/") {
            urlPath = "/index.html";
        }

        const filePath = path.resolve(ROOT, "." + urlPath);

        // Empêche l'accès en dehors du projet
        if (!filePath.startsWith(ROOT)) {
            res.writeHead(403);
            return res.end("Forbidden");
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404, {
                    "Content-Type": "text/plain; charset=utf-8"
                });
                return res.end("404 - Fichier introuvable");
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || "application/octet-stream";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Cache-Control": "no-cache"
            });

            fs.createReadStream(filePath).pipe(res);
        });

    } catch (error) {
        console.error(error);
        res.writeHead(500);
        res.end("Erreur serveur");
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("================================");
    console.log("   PGD-Biblio - Serveur Node");
    console.log("================================");
    console.log(`Site : http://127.0.0.1:${PORT}`);
    console.log(`Racine : ${ROOT}`);
    console.log("================================");
});
