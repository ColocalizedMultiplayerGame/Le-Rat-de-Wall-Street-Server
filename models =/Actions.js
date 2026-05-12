class Action {
    constructor(name, initialPrice, sector, shortName) {
        this.name = name;
        // Si le prix initial est inférieur à 100, on le force à 100
        this.price = Math.max(100, initialPrice);
        this.history = [this.price];
        this.sector = sector;
        this.shortName = shortName;

        // --- Variables d'état pour les mouvements ---

        // Bruit Macro (Les vagues naturelles)
        this.macroVariation = 0;
        this.macroTicksLeft = 0;

        // Tendance (L'impact des news)
        this.newsVariation = 0;
        this.newsTicksLeft = 0;
    }

    tick() {
        // 1. BRUIT MICRO : Frénésie de chaque seconde
        // Beaucoup plus fluctuant : on passe à un impact de ±5.0 par seconde !
        const microNoise = (Math.random() * 2 - 1) * 15.0;

        // 2. BRUIT MACRO : Tendance sur 2 à 6 secondes
        // On augmente légèrement aussi pour que les vagues soient visibles
        if (this.macroTicksLeft <= 0) {
            // On génère une nouvelle "vague" et on choisit sa durée
            this.macroVariation = (Math.random() * 2 - 1) * 6.0;
            this.macroTicksLeft = Math.floor(Math.random() * 5) + 2; // Entre 2 et 6
        }
        this.macroTicksLeft--;

        // 3. LA NEWS : Impact temporaire fort
        if (this.newsTicksLeft > 0) {
            this.newsTicksLeft--;
        } else {
            this.newsVariation = 0; // La news est finie, on remet à 0
        }

        // --- CALCUL FINAL ---
        // On additionne les 3 forces pour obtenir le mouvement de la seconde
        const totalMovement = microNoise + this.macroVariation + this.newsVariation;

        // On applique au prix (avec une sécurité pour ne pas tomber sous 100)
        this.price = Math.max(100, this.price + totalMovement);

        // Arrondi à 2 décimales pour éviter les prix comme 123.45000000001
        this.price = Math.round(this.price * 100) / 100;

        // Sauvegarde de l'historique (50 dernières valeurs)
        this.history.push(this.price);
        if (this.history.length > 50) this.history.shift();
    }

    // Méthode pour déclencher une news depuis l'extérieur
    applyNews(impactPerSecond, durationInSeconds) {
        this.newsVariation = impactPerSecond;
        this.newsTicksLeft = durationInSeconds;
    }
}

module.exports = Action;
