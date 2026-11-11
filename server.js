const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Configuration de la base de données SQLite
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Erreur d\'ouverture de la base de données', err.message);
  } else {
    console.log('Connecté à la base de données SQLite.');
  }
});

// Création des tables nécessaires (si elles n'existent pas)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS trials (
    ip TEXT PRIMARY KEY,
    count INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    rating INTEGER,
    comment TEXT
  )`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ⚠️ IMPORTANT POUR LES FICHIERS STATIQUES :
// Si tes fichiers (index.html, premium.html, etc.) sont dans un dossier "public", garde cette ligne :
app.use(express.static(path.join(__dirname, 'public')));

// (Si tes fichiers sont directement à la racine du projet à côté de server.js, commente la ligne du dessus et décommente celle-ci à la place :)
// app.use(express.static(path.join(__dirname)));


// -----------------------------------------------------------------
// ROUTES DES PAGES HTML
// -----------------------------------------------------------------

// Route principale (Page d'accueil et landing pages par niche)
app.get(['/', '/etudiant', '/comptable', '/immobilier'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html')); // Ajuste avec ou sans 'public/' selon ton arborescence GitHub
});

// Route pour la page de tarifs / Premium
app.get('/premium', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'premium.html')); // Ajuste avec ou sans 'public/' selon ton arborescence GitHub
});

// Route de succès après paiement Stripe
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html')); // Ajuste avec ou sans 'public/' selon ton arborescence GitHub
});


// -----------------------------------------------------------------
// ROUTES API
// -----------------------------------------------------------------

// API : Récupérer le statut de l'utilisateur (essais gratuits fixés à 5)
app.get('/api/status', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  db.get(`SELECT count FROM trials WHERE ip = ?`, [ip], (err, row) => {
    let trialsUsed = row ? row.count : 0;
    let remainingTrials = Math.max(0, 5 - trialsUsed);

    res.json({
      isPaid: false,
      trials: remainingTrials
    });
  });
});

// API : Récupérer les avis clients depuis SQLite
app.get('/api/reviews', (req, res) => {
  db.all(`SELECT name, rating, comment FROM reviews ORDER BY id DESC LIMIT 3`, [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Erreur serveur lors de la récupération des avis." });
    }
    res.json(rows);
  });
});

// API : Route de fusion
app.post('/api/merge', upload.array('pdfs'), (req, res) => {
  res.send("Fichiers fusionnés avec succès !");
});

// API : Route de compression
app.post('/api/compress', upload.single('pdf'), (req, res) => {
  res.send("Fichier compressé avec succès !");
});


// -----------------------------------------------------------------
// LANCEMENT DU SERVEUR
// -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur PDFUltime démarré sur le port ${PORT}`);
});
