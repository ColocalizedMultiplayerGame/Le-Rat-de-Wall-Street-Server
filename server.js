const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

// --- IMPORTATION DE TES MODÈLES ---
const Action = require("./Action");
const GameLoop = require("./GameLoop");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://Alexandre94460vlt.github.io", "http://localhost:3000"], // Ajoute ton URL GitHub et ton URL de test local
    methods: ["GET", "POST"],
  },
});

const publicPath = path.join(__dirname, "public");
const lobbyImagesPath = path.join(publicPath, "assets", "lobby");

app.use(express.static(publicPath));

const PORT = process.env.PORT || 3000;

// ===== PARAMÈTRES DE LA PARTIE =====
const EXPECTED_PLAYERS = 26;

// ===== INITIALISATION DU MARCHÉ =====
const actionTemplates = [
  { name: "Google", shortName: "GGL", initialPrice: 100, sector: "tech" },
  { name: "Microsoft", shortName: "MSFT", initialPrice: 120, sector: "tech" },
  { name: "Apple", shortName: "AAPL", initialPrice: 150, sector: "tech" },
  { name: "FaceBook", shortName: "META", initialPrice: 100, sector: "tech" },
  { name: "Amazon", shortName: "AMZN", initialPrice: 200, sector: "tech" },
  { name: "Tesla", shortName: "TSLA", initialPrice: 180, sector: "auto" },
  { name: "Netflix", shortName: "NFLX", initialPrice: 130, sector: "tech" },
  { name: "Macdonalds", shortName: "MCDO", initialPrice: 100, sector: "food" },
];

function getNumActionsForPlayers(players) {
  if (players <= 2) return 1;
  if (players <= 10) return 2;
  if (players <= 25) return 3;
  return 4;
}

function createRandomActions() {
  const count = getNumActionsForPlayers(EXPECTED_PLAYERS);
  // On mélange
  const shuffled = [...actionTemplates]
    .sort(() => 0.5 - Math.random())
    .slice(0, count);
  // On instancie la vraie classe Action pour chaque template
  return shuffled.map(
    (t) => new Action(t.name, t.initialPrice, t.sector, t.shortName),
  );
}

const activeActions = createRandomActions();

// --- CRÉATION DE LA BOUCLE DE JEU ---
const gameLoop = new GameLoop(activeActions, io, EXPECTED_PLAYERS);

console.log(`Initialisation pour ${EXPECTED_PLAYERS} joueurs attendus.`);
console.log(
  `Création de ${activeActions.length} actions : ${activeActions.map((a) => a.name).join(", ")}`,
);

// ===== ROUTE API =====
app.get("/api/lobby-backgrounds", (req, res) => {
  fs.readdir(lobbyImagesPath, (err, files) => {
    if (err) return res.json([]);
    const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const imageUrls = files
      .filter((file) =>
        allowedExtensions.includes(path.extname(file).toLowerCase()),
      )
      .map((file) => `/assets/lobby/${file}`);
    res.json(imageUrls);
  });
});

// ===== SOCKET.IO (Délégation au GameLoop) =====
io.on("connection", (socket) => {
  console.log("Nouvelle connexion :", socket.id);

  // Initialise le joueur dans le GameLoop
  gameLoop.createPlayer(socket.id);

  socket.on("player:join", (playerName) => {
    gameLoop.joinPlayer(socket.id, playerName);
  });

  socket.on("player:buy", (data) => {
    const actionName = typeof data === "string" ? data : data?.actionName;
    const quantity = Math.max(
      1,
      Number.isInteger(data?.quantity) ? data.quantity : 1,
    );
    gameLoop.buyAction(socket.id, actionName, quantity);
  });

  socket.on("player:sell", (data) => {
    const actionName = typeof data === "string" ? data : data?.actionName;
    const quantity = Math.max(
      1,
      Number.isInteger(data?.quantity) ? data.quantity : 1,
    );
    gameLoop.sellAction(socket.id, actionName, quantity);
  });

  socket.on("admin:open-game", () => {
    // Si le jeu était fermé, c'est une nouvelle partie : on relance les dés !
    if (!gameLoop.isGameOpen) {
      console.log("--- NOUVELLE PARTIE : Génération des actions ---");
      const newActions = createRandomActions(); // On refait un tirage
      gameLoop.reset(newActions); // On nettoie les joueurs et on injecte le tirage
    }

    // On lance le chrono et le marché
    gameLoop.start();
  });

  socket.on("admin:close-game", () => {
    gameLoop.stop();
  });

  socket.on("disconnect", () => {
    gameLoop.removePlayer(socket.id);
    console.log("Déconnexion :", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
