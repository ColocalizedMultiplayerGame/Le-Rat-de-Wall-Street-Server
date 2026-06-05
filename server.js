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
const ALLOWED_ORIGIN = "https://alexandre94460vlt.github.io";

const io = new Server(server, {
  cors: {
    origin: [ALLOWED_ORIGIN, "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
});

// Middleware pour les headers CORS
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
  const count = 300; 
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

// --- GESTION DES SOCKETS ---
io.on("connection", (socket) => {
  console.log(`🔌 Nouveau socket connecté : ${socket.id}`);
  gameLoop.createPlayer(socket.id);

  // REJOINDRE LA PARTIE (PSEUDO)
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
      console.log(`❌ Erreur : Joueur non trouvé pour l'ID ${socket.id}`);
    }
  });

  // ACHAT D'ACTION
  socket.on("player:buy", (data) => {
    console.log(`🛒 REÇU player:buy de ${socket.id} | Contenu:`, data);
    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);

      if (!actionIdentifier || isNaN(quantity)) {
        console.log(`❌ Données d'achat invalides.`);
        return;
      }

      console.log(`🚀 Exécution buyAction("${actionIdentifier}", ${quantity})`);
      gameLoop.buyAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 CRASH interne lors de l'achat :`, err);
    }
  });

  // VENTE D'ACTION
  socket.on("player:sell", (data) => {
    console.log(`💰 REÇU player:sell de ${socket.id} | Contenu:`, data);
    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);
      gameLoop.sellAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 CRASH interne lors de la vente :`, err);
    }
  });

  // COMMANDES ADMIN
  socket.on("admin:open-game", () => {
    console.log("👑 Admin : Ouverture du marché");
    if (!gameLoop.isGameOpen) gameLoop.reset(createRandomActions());
    gameLoop.start();
    // On force le passage sur l'écran "game" pour tout le monde
    io.emit("player:joined", { isGameOpen: true });
  });

  socket.on("admin:close-game", () => {
    console.log("👑 Admin : Fermeture du marché");
    
    // 1. On arrête la boucle automatique du jeu
    gameLoop.stop();
    
    // 2. On passe explicitement le statut du jeu à fermé
    gameLoop.isGameOpen = false;

    // 3. On génère le classement final (généralement géré par ton tableau de joueurs converti en array trié)
    const finalLeaderboard = Object.values(gameLoop.players)
      .filter(p => p.hasJoined)
      .map(p => ({
        id: p.id,
        name: p.name,
        totalValue: p.totalValue || 0 // Assure-toi que cette propriété existe dans ton GameLoop
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    // 4. On crée le paquet de stats attendu par ton client
    const finalStats = {
      leaderboard: finalLeaderboard,
      totalPlayers: finalLeaderboard.length
      // Tu peux ajouter ici d'autres stats globales si ton fichier endscreen en a besoin
    };

    // 5. On envoie le TOUT DERNIER update critique pour déclencher la redirection des clients !
    io.emit("game:update", {
      isGameOpen: false,
      endStats: finalStats,
      actions: gameLoop.actions || [] // On laisse les actions pour éviter un crash au map() du graphique
    });
    
    console.log("✅ Stats de fin envoyées à tous les joueurs.");
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    console.log(`🚫 Déconnexion : ${socket.id}`);
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
