const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const Action = require("./Action");
const GameLoop = require("./GameLoop");

const app = express();
const server = http.createServer(app);

// --- CONFIGURATION CORS GLOBALE ---
// Assure-toi que cette URL correspond exactement à ton lien GitHub Pages (sans slash à la fin)
const ALLOWED_ORIGIN = "https://alexandre94460vlt.github.io";

const io = new Server(server, {
  cors: {
    origin: [ALLOWED_ORIGIN, "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
});

// Middleware pour les headers CORS (pour les requêtes API classiques)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const publicPath = path.join(__dirname, "public");
const lobbyImagesPath = path.join(publicPath, "assets", "lobby");
app.use(express.static(publicPath));

const PORT = process.env.PORT || 3000;
const EXPECTED_PLAYERS = 26;

// --- INITIALISATION JEU ---
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

function createRandomActions() {
  const count = 4; 
  return [...actionTemplates]
    .sort(() => 0.5 - Math.random())
    .slice(0, count)
    .map(t => new Action(t.name, t.initialPrice, t.sector, t.shortName));
}

const gameLoop = new GameLoop(createRandomActions(), io, EXPECTED_PLAYERS);

// --- ROUTES API ---
app.get("/api/lobby-backgrounds", (req, res) => {
  fs.readdir(lobbyImagesPath, (err, files) => {
    if (err) return res.json([]);
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    const urls = files
      .filter(f => allowed.includes(path.extname(f).toLowerCase()))
      .map(f => `/assets/lobby/${f}`);
    res.json(urls);
  });
});

// --- GESTION DES SOCKETS (COMMUNICATION TEMPS RÉEL) ---
// --- GESTION DES SOCKETS DANS SERVER.JS ---
io.on("connection", (socket) => {
  console.log(`🔌 Nouveau socket connecté : ${socket.id}`);
  gameLoop.createPlayer(socket.id);

  // LOG DU PSEUDO
  socket.on("player:join", (name) => {
    console.log(`📝 Tentative de join : ID=${socket.id}, Pseudo=${name}`);
    const player = gameLoop.players[socket.id];
    if (player) {
      player.name = name;
      player.hasJoined = true;
      player.isActive = gameLoop.isGameOpen;
      socket.emit("player:joined", { isGameOpen: gameLoop.isGameOpen, name: player.name });
      console.log(`✅ Joueur enregistré : ${player.name}`);
    } else {
      console.log(`❌ Erreur : Joueur non trouvé dans la liste pour l'ID ${socket.id}`);
    }
  });

  // LOG D'ACHAT (LE POINT CRITIQUE)
  socket.on("player:buy", (data) => {
    console.log(`🛒 REÇU player:buy de ${socket.id}`);
    console.log(`📦 Contenu du message :`, data);

    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);

      if (!actionIdentifier || isNaN(quantity)) {
        console.log(`❌ Données invalides : Nom=${actionIdentifier}, Qté=${quantity}`);
        return;
      }

      // On appelle la fonction et on regarde si elle s'exécute
      console.log(`🚀 Appel de gameLoop.buyAction("${actionIdentifier}", ${quantity})`);
      gameLoop.buyAction(socket.id, actionIdentifier, quantity);
      
    } catch (err) {
      console.error(`💥 CRASH interne lors de l'achat :`, err);
    }
  });

  // LOG DE VENTE
  socket.on("player:sell", (data) => {
    console.log(`💰 REÇU player:sell de ${socket.id}`, data);
    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);
      gameLoop.sellAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 CRASH interne lors de la vente :`, err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🚫 Déconnexion : ${socket.id}`);
    gameLoop.removePlayer(socket.id);
  });
});
  // COMMANDES ADMIN
  // COMMANDES ADMIN
  socket.on("admin:open-game", () => {
    console.log("Admin : Ouverture du marché");
    if (!gameLoop.isGameOpen) gameLoop.reset(createRandomActions());
    gameLoop.start();

    // IMPORTANT : On envoie à tout le monde l'ordre de passer sur l'écran "game"
    io.emit("player:joined", {
      isGameOpen: true
    });
  });

  socket.on("admin:close-game", () => {
    console.log("Admin : Fermeture du marché");
    gameLoop.stop();
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    console.log("Déconnexion :", socket.id);
    gameLoop.removePlayer(socket.id);
  });
});

// Lancement du serveur
server.listen(PORT, "0.0.0.0", () => {
  console.log(`=========================================`);
  console.log(`Serveur "Le Rat de Wall Street" démarré !`);
  console.log(`Port : ${PORT}`);
  console.log(`Origine autorisée : ${ALLOWED_ORIGIN}`);
  console.log(`=========================================`);
});
