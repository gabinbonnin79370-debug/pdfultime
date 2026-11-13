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

// Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------
// ROUTES DES PAGES HTML
// -----------------------------------------------------------------
app.get(['/', '/etudiant', '/comptable', '/immobilier'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/premium', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'premium.html'));
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});


// -----------------------------------------------------------------
// ROUTES API
// -----------------------------------------------------------------
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

app.get('/api/reviews', (req, res) => {
  db.all(`SELECT name, rating, comment FROM reviews ORDER BY id DESC LIMIT 3`, [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Erreur serveur lors de la récupération des avis." });
    }
    res.json(rows);
  });
});

app.post('/api/merge', upload.array('pdfs'), (req, res) => {
  res.send("Fichiers fusionnés avec succès !");
});

// API Compression prenant en compte le mode (Standard ou Maximum)
app.post('/api/compress', upload.single('pdf'), (req, res) => {
  const compressionMode = req.body.mode || 'standard';
  console.log(`Fichier reçu pour compression en mode : ${compressionMode}`);
  
  // Ici tu ajoutes ton traitement de compression selon le mode
  res.send(`Fichier compressé avec succès en mode ${compressionMode} !`);
});

app.post('/api/extract-pages', upload.single('pdf'), (req, res) => {
  const pagesToKeep = req.body.pages;
  res.send(`Pages ${pagesToKeep} extraites avec succès !`);
});


// -----------------------------------------------------------------
// LANCEMENT DU SERVEUR
// -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur PDFUltime démarré sur le port ${PORT}`);
});
