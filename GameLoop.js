const NewsManager = require('./NewsManager');

class GameLoop {
    constructor(actions, io, expectedPlayers = 1) {
        this.actions = actions;
        this.io = io;
        this.expectedPlayers = expectedPlayers;
        this.players = {};
        this.interval = null;
        this.isGameOpen = false;

        this.newsManager = new NewsManager();
        this.tickCount = 0;

        // --- MÉMOIRE POUR LES STATS DE FIN ---
        this.tradeCounts = {}; // { socketId: nombre_de_transactions }
        this.wasTop1 = new Set(); // Sauvegarde les ID de tous ceux qui ont été 1er
        this.nemesisSwaps = {}; // Compte les croisements entre 2 joueurs
        this.leaderboardHistory = []; // Historique pour la remontada
        this.lastLb = []; // Classement de la seconde précédente
    }

    reset(newActions) {
        // 1. On remplace les vieilles actions par le nouveau tirage
        this.actions = newActions;

        // 2. On remet les compteurs de la boucle à zéro
        this.tickCount = 0;
        this.newsManager = new NewsManager(); // Réinitialise l'humeur des news

        // 3. On vide la mémoire des stats de fin de partie
        this.tradeCounts = {};
        this.wasTop1 = new Set();
        this.nemesisSwaps = {};
        this.leaderboardHistory = [];
        this.lastLb = [];

        // 4. On réinitialise TOUS les joueurs connectés (Même ceux en salle d'attente)
        for (const socketId in this.players) {
            const player = this.players[socketId];
            player.cash = 10000; // On redonne les 10 000€
            player.portfolio = {}; // On vide l'ancien portefeuille

            // On recrée les lignes du portefeuille avec les NOUVELLES actions
            this.actions.forEach(action => {
                player.portfolio[action.name] = { quantity: 0, invested: 0 };
            });

            this.tradeCounts[socketId] = 0;
        }
    }

    start() {
        if (this.isGameOpen) return;
        this.isGameOpen = true;

        for (const player of Object.values(this.players)) {
            if (player.hasJoined) player.isActive = true;
        }

        if (!this.interval) {
            this.interval = setInterval(() => this.tick(), 1000);
        }
        this.broadcastGameState();
    }

    stop() {
        this.isGameOpen = false;
        for (const player of Object.values(this.players)) {
            if (player.hasJoined) player.isActive = false;
        }

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        // --- GÉNÉRATION DES STATS À LA FERMETURE ---
        const endStats = this.generateEndStats();
        this.broadcastGameState(null, endStats);
    }

    tick() {
        this.tickCount++;
        let activeNewsEvent = null;

        if (this.tickCount % 10 === 0) {
            activeNewsEvent = this.newsManager.generateNews(this.actions);
        }

        this.actions.forEach(action => action.tick());

        // --- TRACKING DES STATS EN TEMPS RÉEL ---
        const currentLb = this.getLeaderboard();

        // 1. Qui a touché le Top 1 ?
        if (currentLb.length > 0) this.wasTop1.add(currentLb[0].id);

        // 2. Traque des Nemesis (Croisements au classement)
        if (this.lastLb && this.lastLb.length > 0) {
            for (let i = 0; i < currentLb.length; i++) {
                for (let j = i + 1; j < currentLb.length; j++) {
                    const p1 = currentLb[i].id;
                    const p2 = currentLb[j].id;

                    const p1Past = this.lastLb.findIndex(p => p.id === p1);
                    const p2Past = this.lastLb.findIndex(p => p.id === p2);

                    // Si p2 était devant p1, et que maintenant p1 est devant (car i < j)
                    if (p1Past !== -1 && p2Past !== -1 && p2Past < p1Past) {
                        const pairKey = [p1, p2].sort().join('|');
                        this.nemesisSwaps[pairKey] = (this.nemesisSwaps[pairKey] || 0) + 1;
                    }
                }
            }
        }

        this.lastLb = currentLb;
        this.leaderboardHistory.push(currentLb);

        this.broadcastGameState(activeNewsEvent);
    }

    createPlayer(socketId) {
        const portfolio = {};
        this.actions.forEach(action => {
            portfolio[action.name] = { quantity: 0, invested: 0 };
        });

        this.players[socketId] = {
            id: socketId,
            name: "",
            cash: 10000,
            portfolio,
            hasJoined: false,
            isActive: false
        };
        this.tradeCounts[socketId] = 0; // Initialise le compteur de trades

        this.emitPlayerState(socketId);
        this.emitLobbyState();
    }

    joinPlayer(socketId, playerName) {
        const player = this.players[socketId];
        if (!player) return;
        player.name = (playerName || "Joueur").trim() || "Joueur";
        player.hasJoined = true;
        player.isActive = this.isGameOpen;
        this.io.to(socketId).emit("player:joined", { isGameOpen: this.isGameOpen, isWaiting: !this.isGameOpen });
        this.broadcastGameState();
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        this.broadcastGameState();
    }

   // DANS GAMELOOP.JS
buyAction(socketId, actionIdentifier, quantity) {
    const player = this.players[socketId];
    
    // LOG 1 : Est-ce que le joueur existe et est actif ?
    if (!player) { console.log("LB: Joueur inexistant"); return; }
    if (!player.isActive) { console.log(`LB: Joueur ${player.name} non actif`); return; }

    // LOG 2 : Est-ce que le serveur trouve l'action ?
    const action = this.actions.find(a => 
        a.name.toLowerCase() === actionIdentifier.toLowerCase() || 
        a.shortName.toLowerCase() === actionIdentifier.toLowerCase()
    );

    if (!action) {
        console.log(`LB: Action "${actionIdentifier}" introuvable dans le marché !`);
        console.log("Actions dispo :", this.actions.map(a => a.name));
        return;
    }

    const cost = action.price * quantity;
    
    // LOG 3 : Problème d'argent ?
    if (player.cash < cost) {
        console.log(`LB: ${player.name} n'a pas assez de cash (${player.cash} < ${cost})`);
        return;
    }

    // SI ON ARRIVE ICI, ÇA DOIT MARCHER
    player.cash -= cost;
    player.portfolio[action.name].quantity += quantity;
    player.portfolio[action.name].invested += cost;
    this.tradeCounts[socketId]++;

    console.log(`✅ ACHAT RÉUSSI : ${player.name} a acheté ${quantity} ${action.name}`);
    
    this.emitPlayerState(socketId);
}

    sellAction(socketId, actionIdentifier, quantity) {
        const player = this.players[socketId];
        if (!player || !player.isActive || !this.isGameOpen) return;
        const action = this.actions.find(a => a.name === actionIdentifier || a.shortName === actionIdentifier);
        if (!action) return;

        const ownedQuantity = player.portfolio[action.name]?.quantity || 0;
        if (ownedQuantity < quantity) return;

        const avgCost = player.portfolio[action.name].invested / ownedQuantity;
        player.portfolio[action.name].quantity -= quantity;
        player.portfolio[action.name].invested -= avgCost * quantity;
        player.cash += action.price * quantity;

        if (player.portfolio[action.name].quantity === 0) {
            player.portfolio[action.name].invested = 0;
        }

        this.tradeCounts[socketId]++;

        // CORRECTION : Pareil ici, feedback instantané uniquement pour le vendeur
        this.emitPlayerState(socketId);
    }

    getPlayerTotalValue(player) {
        let total = player.cash;
        for (const action of this.actions) {
            const qty = player.portfolio[action.name]?.quantity || 0;
            total += qty * action.price;
        }
        return total;
    }

    getLeaderboard() {
        return Object.values(this.players)
            .filter(p => p.hasJoined)
            .map(p => ({
                id: p.id,
                name: p.name,
                cash: p.cash,
                portfolio: p.portfolio,
                totalValue: this.getPlayerTotalValue(p)
            }))
            .sort((a, b) => b.totalValue - a.totalValue);
    }

    getPublicActions() {
        return this.actions.map(action => ({
            name: action.name,
            shortName: action.shortName,
            sector: action.sector,
            currentPrice: action.price,
            history: action.history.slice(-50) // On ne garde que les 50 derniers points
        }));
    }

    // NOUVEAU : Pour les téléphones des joueurs (Ultra-léger)
    getMobileActions() {
        return this.actions.map(action => ({
            name: action.name,
            shortName: action.shortName,
            sector: action.sector,
            currentPrice: action.price
            // AUCUN HISTORIQUE ICI ! Le poids des données est divisé par 100.
        }));
    }

    emitLobbyState() {
        const playersArr = Object.values(this.players);
        this.io.emit("lobby:update", {
            isGameOpen: this.isGameOpen,
            waitingCount: playersArr.filter(p => p.hasJoined && !p.isActive).length,
            activeCount: playersArr.filter(p => p.hasJoined && p.isActive).length
        });
    }

    emitPlayerState(socketId, precalculatedActions = null) {
        const player = this.players[socketId];
        if (!player) return;
        this.io.to(socketId).emit("player:update", {
            name: player.name,
            cash: player.cash,
            portfolio: player.portfolio,
            // On utilise les actions précalculées si elles sont fournies
            actions: precalculatedActions || this.getPublicActions(),
            totalValue: this.getPlayerTotalValue(player),
            isGameOpen: this.isGameOpen,
            isWaiting: player.hasJoined && !player.isActive,
            isActive: player.isActive
        });
    }

    // --- LOGIQUE DE CALCUL DES AWARDS DE FIN ---
    // --- LOGIQUE DE CALCUL DES AWARDS DE FIN ---
    generateEndStats() {
        const finalLb = this.getLeaderboard();
        if (finalLb.length === 0) return null;

        const stats = {
            podium: finalLb.slice(0, 5),
            poorest: finalLb[finalLb.length - 1],
            remontada: null,
            fallOff: null,
            nemesis: null,
            frenetic: null,
            squirrel: null,
            rat: null // On initialise bien la stat du rat ici
        };

        // 1. Remontada (Milieu de partie vs Fin)
        if (this.leaderboardHistory.length > 0) {
            const midIndex = Math.floor(this.leaderboardHistory.length / 2);
            const midLb = this.leaderboardHistory[midIndex];
            let maxGained = 0;
            let remontadaPlayer = null;

            finalLb.forEach((player, finalRank) => {
                const pastRank = midLb.findIndex(p => p.id === player.id);
                if (pastRank !== -1) {
                    const gained = pastRank - finalRank;
                    if (gained > maxGained) {
                        maxGained = gained;
                        remontadaPlayer = player;
                    }
                }
            });
            if (remontadaPlayer && maxGained > 0) stats.remontada = { player: remontadaPlayer, places: maxGained };
        }

        // 2. Fall Off (A été top 1, finit le plus bas)
        let worstRankForTop1 = -1;
        let fallOffPlayer = null;
        this.wasTop1.forEach(id => {
            const finalRank = finalLb.findIndex(p => p.id === id);
            if (finalRank > worstRankForTop1 && finalRank !== 0) {
                worstRankForTop1 = finalRank;
                fallOffPlayer = finalLb[finalRank];
            }
        });
        if (fallOffPlayer) stats.fallOff = { player: fallOffPlayer, finalRank: worstRankForTop1 + 1 };

        // 3. Nemesis
        let maxSwaps = 0;
        let nemesisPair = null;
        for (const [pairKey, swaps] of Object.entries(this.nemesisSwaps)) {
            if (swaps > maxSwaps) {
                maxSwaps = swaps;
                const [id1, id2] = pairKey.split('|');
                const p1 = finalLb.find(p => p.id === id1);
                const p2 = finalLb.find(p => p.id === id2);
                if (p1 && p2) nemesisPair = { p1, p2, swaps };
            }
        }
        stats.nemesis = nemesisPair;

        // 4. Le Frénétique
        let maxTrades = 0;
        let freneticPlayer = null;
        for (const [id, trades] of Object.entries(this.tradeCounts)) {
            if (trades > maxTrades) {
                maxTrades = trades;
                freneticPlayer = finalLb.find(p => p.id === id);
            }
        }
        if (freneticPlayer) stats.frenetic = { player: freneticPlayer, trades: maxTrades };

        // 5. L'Écureuil
        let maxCash = 0;
        let squirrelPlayer = null;
        finalLb.forEach(p => {
            if (p.cash > maxCash) {
                maxCash = p.cash;
                squirrelPlayer = p;
            }
        });
        if (squirrelPlayer) stats.squirrel = { player: squirrelPlayer, cash: maxCash };

        // 6. Le Rat de Wall Street (Le plus petit investisseur actif)
        let minInvested = Infinity;
        let ratPlayer = null;

        finalLb.forEach(p => {
            let totalInvested = 0;
            for (const action in p.portfolio) {
                totalInvested += p.portfolio[action].invested;
            }
            if (totalInvested >= 1 && totalInvested < minInvested) {
                minInvested = totalInvested;
                ratPlayer = p;
            }
        });

        if (ratPlayer) {
            stats.rat = { player: ratPlayer, amount: Math.round(minInvested) };
        }

        return stats;
    }

    // Ajout de endStats dans la diffusion
    broadcastGameState(newsEvent = null, endStats = null) {
        // On prépare les deux paquets
        const screenActions = this.getPublicActions(); // Pour l'écran (avec historique max 50)
        const mobileActions = this.getMobileActions(); // Pour les téléphones (sans historique)
        const leaderboard = this.getLeaderboard();

        // 1. Envoi global (principalement écouté par le Screen)
        this.io.emit("game:update", {
            isGameOpen: this.isGameOpen,
            actions: screenActions,
            leaderboard: leaderboard,
            newsEvent,
            endStats
        });

        this.emitLobbyState();

        // 2. Envoi individuel ultra-léger aux téléphones
        for (const socketId in this.players) {
            // On envoie 'mobileActions' au lieu de la grosse liste
            this.emitPlayerState(socketId, mobileActions);
        }
    }

    reset(newActions) {
        // 1. On remplace les vieilles actions par le nouveau tirage
        this.actions = newActions;

        // 2. On remet les compteurs de la boucle à zéro
        this.tickCount = 0;
        this.newsManager = new NewsManager(); // Réinitialise l'humeur des news

        // 3. On vide la mémoire des stats de fin de partie
        this.tradeCounts = {};
        this.wasTop1 = new Set();
        this.nemesisSwaps = {};
        this.leaderboardHistory = [];
        this.lastLb = [];

        // 4. On réinitialise TOUS les joueurs connectés (Même ceux en salle d'attente)
        for (const socketId in this.players) {
            const player = this.players[socketId];
            player.cash = 10000; // On redonne les 10 000€
            player.portfolio = {}; // On vide l'ancien portefeuille

            // On recrée les lignes du portefeuille avec les NOUVELLES actions
            this.actions.forEach(action => {
                player.portfolio[action.name] = { quantity: 0, invested: 0 };
            });

            this.tradeCounts[socketId] = 0;
        }
    }
}

module.exports = GameLoop;
