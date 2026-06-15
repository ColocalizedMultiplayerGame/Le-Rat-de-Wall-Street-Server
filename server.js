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

// --- INITIALISATION JEU (TEMPLATES) ---
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
const activeRooms = {};

function getOrCreateRoom(roomId) {
  if (!roomId) return null;
  const upperRoomId = roomId.toUpperCase();
  
  if (!activeRooms[upperRoomId]) {
    console.log(`📦 Création de la session de jeu pour la Room : ${upperRoomId}`);
    
    // Création d'un wrapper IO sécurisé pour confiner GameLoop à sa propre room
    const customIoForRoom = {
      emit: (event, data) => {
        io.to(upperRoomId).emit(event, data);
      },
      to: (room) => io.to(room),
      in: (room) => io.in(room)
    };

    try {
      // Injection directe du faux moteur IO pour éviter le crash 502
      const loop = new GameLoop(createRandomActions(), customIoForRoom, EXPECTED_PLAYERS);
      
      activeRooms[upperRoomId] = {
        gameLoop: loop
      };
    } catch (error) {
      console.error(`💥 ÉCHEC CRITIQUE au démarrage de la Room ${upperRoomId} :`, error);
      return null;
    }
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

// --- GESTION DES SOCKETS ---
io.on("connection", (socket) => {
  console.log(`🔌 Nouveau socket connecté : ${socket.id}`);
  
  // Stockage local de la room associée à ce client pour simplifier la déconnexion
  let currentSocketRoom = null;

  // 1. LOBBY ADMIN : Créer / rejoindre la room
  socket.on("admin:join-room", ({ roomId }) => {
    if (!roomId) return;
    const roomKey = roomId.toUpperCase();
    socket.join(roomKey);
    currentSocketRoom = roomKey;
    getOrCreateRoom(roomKey);
    console.log(`👑 Admin connecté au salon : ${roomKey}`);
  });

  // 2. SCREEN : Rejoindre et écouter la room
  socket.on("screen:join-room", ({ roomId }) => {
    if (!roomId) return;
    const roomKey = roomId.toUpperCase();
    socket.join(roomKey);
    currentSocketRoom = roomKey;
    getOrCreateRoom(roomKey);
    console.log(`📺 Écran principal connecté au salon : ${roomKey}`);
  });

  // 3. JOUER/MANETTE : Rejoindre la room avec son pseudo
  socket.on("player:join-room", ({ roomId, playerName }) => {
    if (!roomId || !playerName) return;
    const roomKey = roomId.toUpperCase();
    
    socket.join(roomKey);
    currentSocketRoom = roomKey;
    
    const room = getOrCreateRoom(roomKey);
    if (!room) return;

    const gl = room.gameLoop;
    gl.createPlayer(socket.id);

    const player = gl.players[socket.id];
    if (player) {
      player.name = playerName;
      player.hasJoined = true;
      player.isActive = gl.isGameOpen;
      
      socket.emit("player:joined", { isGameOpen: gl.isGameOpen, name: player.name });
      console.log(`✅ Joueur enregistré : ${player.name} dans la Room ${roomKey}`);
    }
  });

  // 4. ACHAT D'ACTION
  socket.on("player:buy", (data) => {
    if (!currentSocketRoom || !activeRooms[currentSocketRoom]) return;
    const gl = activeRooms[currentSocketRoom].gameLoop;

    console.log(`🛒 REÇU player:buy de ${socket.id} dans Room ${currentSocketRoom}`);
    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);

      if (!actionIdentifier || isNaN(quantity)) {
        console.log(`❌ Données d'achat invalides.`);
        return;
      }

      gl.buyAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 CRASH interne lors de l'achat :`, err);
    }
  });

  // 5. VENTE D'ACTION
  socket.on("player:sell", (data) => {
    if (!currentSocketRoom || !activeRooms[currentSocketRoom]) return;
    const gl = activeRooms[currentSocketRoom].gameLoop;

    console.log(`💰 REÇU player:sell de ${socket.id} dans Room ${currentSocketRoom}`);
    try {
      const actionIdentifier = data.actionName || data.name;
      const quantity = parseInt(data.quantity);
      gl.sellAction(socket.id, actionIdentifier, quantity);
    } catch (err) {
      console.error(`💥 CRASH interne lors de la vente :`, err);
    }
  });

  // 6. COMMANDES ADMIN - OUVERTURE
  socket.on("admin:open-game", (data) => {
    const targetRoom = (data && data.roomId) ? data.roomId : currentSocketRoom;
    if (!targetRoom || !activeRooms[targetRoom.toUpperCase()]) return;
    
    const roomKey = targetRoom.toUpperCase();
    const gl = activeRooms[roomKey].gameLoop;

    console.log(`👑 Admin : Ouverture du marché pour la Room ${roomKey}`);
    if (!gl.isGameOpen) gl.reset(createRandomActions());
    gl.start();
    
    // Forcer le passage sur l'écran de jeu uniquement pour cette room
    io.to(roomKey).emit("player:joined", { isGameOpen: true });
  });

  // 7. COMMANDES ADMIN - FERMETURE
  socket.on("admin:close-game", (data) => {
    const targetRoom = (data && data.roomId) ? data.roomId : currentSocketRoom;
    if (!targetRoom || !activeRooms[targetRoom.toUpperCase()]) return;
    
    const roomKey = targetRoom.toUpperCase();
    const gl = activeRooms[roomKey].gameLoop;

    console.log(`👑 Admin : Fermeture du marché pour la Room ${roomKey}`);
    
    gl.stop();
    gl.isGameOpen = false;

    // Classement final spécifique à cette room
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

    io.to(roomKey).emit("game:update", {
      isGameOpen: false,
      endStats: finalStats,
      actions: gl.actions || []
    });
    
    console.log(`✅ Stats de fin envoyées à la Room ${roomKey}.`);
  });

  // 8. DÉCONNEXION
  socket.on("disconnect", () => {
    if (currentSocketRoom && activeRooms[currentSocketRoom]) {
      const gl = activeRooms[currentSocketRoom].gameLoop;
      console.log(`🚫 Déconnexion : ${socket.id} de la Room ${currentSocketRoom}`);
      gl.removePlayer(socket.id);

      // Si la room devient complètement vide, on nettoie la mémoire RAM
      const totalRemaining = Object.keys(gl.players).length;
      if (totalRemaining === 0 && !gl.isGameOpen) {
        console.log(`🗑️ Nettoyage de la Room vide : ${currentSocketRoom}`);
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
