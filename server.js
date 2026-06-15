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

// --- DÉFINITION DES ACTIONS ---
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

// --- STRUCTURE DE STOCKAGE MULTI-SESSION ---
// Contiendra des objets du type : { [roomId]: { gameLoop: GameLoopInstance } }
const activeRooms = {};

// Fonction utilitaire pour initialiser une room si elle n'existe pas
function getOrCreateRoom(roomId) {
  if (!roomId) return null;
  const upperRoomId = roomId.toUpperCase();
  if (!activeRooms[upperRoomId]) {
    console.log(`📦 Création de la session de jeu pour la Room : ${upperRoomId}`);
    
    // On crée une instance unique de GameLoop pour cette room.
    // L'astuce est de passer un proxy ou un objet restreint à la room pour l'accès IO global de ton GameLoop,
    // ou d'ajuster l'émission directement ciblée.
    const loop = new GameLoop(createRandomActions(), io, EXPECTED_PLAYERS);
    
    // Modification dynamique pour restreindre les émetteurs automatiques de ton GameLoop à la room
    const originalEmit = io.emit;
    // Si ton GameLoop utilise en interne 'this.io.emit', on le redirige vers la room cible
    loop.io = {
      emit: (event, data) => io.to(upperRoomId).emit(event, data)
    };

    activeRooms[upperRoomId] = {
      gameLoop: loop
    };
  }
  return activeRooms[upperRoomId];
}

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

// --- GESTION DES SOCKETS VIA ROOMS ---
io.on("connection", (socket) => {
  console.log(`🔌 Nouveau socket connecté : ${socket.id}`);

  // Garder en mémoire la room actuelle reliée à ce socket pour le nettoyage
  let currentSocketRoom = null;

  // ADMIN UNIQUE : Joint la room depuis lobby.js
  socket.on("admin:join-room", ({ roomId }) => {
    if (!roomId) return;
    const roomKey = roomId.toUpperCase();
    socket.join(roomKey);
    currentSocketRoom = roomKey;
    getOrCreateRoom(roomKey);
    console.log(`👑 Admin connecté et à l'écoute du salon : ${roomKey}`);
  });

  // SCREEN UNIQUE : Joint la room depuis screen.js
  socket.on("screen:join-room", ({ roomId }) => {
    if (!roomId) return;
    const roomKey = roomId.toUpperCase();
    socket.join(roomKey);
    currentSocketRoom = roomKey;
    getOrCreateRoom(roomKey);
    console.log(`📺 Écran de jeu connecté au salon : ${roomKey}`);
  });

  // JOUEUR MANETTE : Joint la room depuis player.js
  socket.on("player:join-room", ({ roomId, playerName }) => {
    if (!roomId || !playerName) return;
    const roomKey = roomId.toUpperCase();
    
    socket.join(roomKey);
    currentSocketRoom = roomKey;
    
    const room = getOrCreateRoom(roomKey);
    const gl = room.gameLoop;

    // On crée le joueur dans le GameLoop de ce salon spécifique
    gl.createPlayer(socket.id);
    
    const player = gl.players[socket.id];
    if (player) {
      player.name = playerName;
      player.hasJoined = true;
      player.isActive = gl.isGameOpen;
      
      socket.emit("player:joined", { isGameOpen: gl.isGameOpen, name: player.name });
      console.log(`✅ Joueur enregistré [${playerName}] dans le salon [${roomKey}]`);
    }
  });

  // ACHAT D'ACTION
  socket.on("player:buy", (data) => {
    if (!currentSocketRoom || !activeRooms[currentSocketRoom]) return;
    const gl = activeRooms[currentSocketRoom].gameLoop;

    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);

      if (!actionIdentifier || isNaN(quantity)) return;
      gl.buyAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 Erreur achat Room ${currentSocketRoom}:`, err);
    }
  });

  // VENTE D'ACTION
  socket.on("player:sell", (data) => {
    if (!currentSocketRoom || !activeRooms[currentSocketRoom]) return;
    const gl = activeRooms[currentSocketRoom].gameLoop;

    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);
      gl.sellAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 Erreur vente Room ${currentSocketRoom}:`, err);
    }
  });

  // COMMANDES ADMIN - OUVERTURE
  socket.on("admin:open-game", (data) => {
    // Récupération de l'ID via le paramètre ou l'état du socket
    const rId = (data && data.roomId) ? data.roomId : currentSocketRoom;
    if (!rId || !activeRooms[rId.toUpperCase()]) return;
    
    const roomKey = rId.toUpperCase();
    const gl = activeRooms[roomKey].gameLoop;

    console.log(`👑 Admin : Ouverture du marché pour le salon ${roomKey}`);
    if (!gl.isGameOpen) gl.reset(createRandomActions());
    gl.start();
    
    // On force le passage sur l'écran "game" uniquement pour les membres de ce salon
    io.to(roomKey).emit("player:joined", { isGameOpen: true });
  });

  // COMMANDES ADMIN - FERMETURE
  socket.on("admin:close-game", (data) => {
    const rId = (data && data.roomId) ? data.roomId : currentSocketRoom;
    if (!rId || !activeRooms[rId.toUpperCase()]) return;
    
    const roomKey = rId.toUpperCase();
    const gl = activeRooms[roomKey].gameLoop;

    console.log(`👑 Admin : Fermeture du marché pour le salon ${roomKey}`);
    
    gl.stop();
    gl.isGameOpen = false;

    // Génération du classement final propre à cette session
    const finalLeaderboard = Object.values(gl.players)
      .filter(p => p.hasJoined)
      .map(p => ({
        id: p.id,
        name: p.name,
        totalValue: p.totalValue || 0 
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    const finalStats = {
      leaderboard: finalLeaderboard,
      totalPlayers: finalLeaderboard.length
    };

    // Notification exclusive des clients de cette room
    io.to(roomKey).emit("game:update", {
      isGameOpen: false,
      endStats: finalStats,
      actions: gl.actions || []
    });
  });

  // DÉCONNEXION AUTOMATIQUE ET SÉCURISÉE
  socket.on("disconnect", () => {
    if (currentSocketRoom && activeRooms[currentSocketRoom]) {
      const gl = activeRooms[currentSocketRoom].gameLoop;
      console.log(`🚫 Déconnexion de ${socket.id} du salon ${currentSocketRoom}`);
      gl.removePlayer(socket.id);

      // Optionnel : Si le salon est totalement vide, on peut le supprimer de la mémoire
      const remainingPlayers = Object.keys(gl.players).length;
      if (remainingPlayers === 0 && !gl.isGameOpen) {
         console.log(`🗑️ Salon ${currentSocketRoom} inactif et vide. Nettoyage de la mémoire.`);
         delete activeRooms[currentSocketRoom];
      }
    }
  });
});

// Lancement du serveur
server.listen(PORT, "0.0.0.0", () => {
  console.log(`=========================================`);
  console.log(`Serveur "Le Rat de Wall Street" MULTI-SESSION démarré !`);
  console.log(`Port : ${PORT}`);
  console.log(`Origine autorisée : ${ALLOWED_ORIGIN}`);
  console.log(`=========================================`);
});
