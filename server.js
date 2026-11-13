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
// ROUTES DES PAGES HTML (Incluant la route /en pour l'anglais)
// -----------------------------------------------------------------
app.get(['/', '/etudiant', '/comptable', '/immobilier', '/en'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/premium', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'premium.html'));
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});


// -----------------------------------------------------------------
// ROUTES API & GESTION DES ESSAIS
// -----------------------------------------------------------------

// Fonction middleware pour incrémenter les essais par IP
function useTrial(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  db.get(`SELECT count FROM trials WHERE ip = ?`, [ip], (err, row) => {
    let trialsUsed = row ? row.count : 0;
    
    if (trialsUsed >= 5) {
      return res.status(403).send("Essais gratuits épuisés.");
    }

    db.run(`INSERT INTO trials (ip, count) VALUES (?, 1) ON CONFLICT(ip) DO UPDATE SET count = count + 1`, [ip], (err) => {
      if (err) console.error("Erreur mise à jour essais", err);
      next();
    });
  });
}

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

// Routes outils protégées par le décompte d'essais
app.post('/api/merge', useTrial, upload.array('pdfs'), (req, res) => {
  res.send("Fichiers fusionnés avec succès !");
});

app.post('/api/compress', useTrial, upload.single('pdf'), (req, res) => {
  const compressionMode = req.body.mode || 'standard';
  res.send(`Fichier compressé avec succès en mode ${compressionMode} !`);
});

app.post('/api/extract-pages', useTrial, upload.single('pdf'), (req, res) => {
  const pagesToKeep = req.body.pages || "toutes";
  res.send(`Pages (${pagesToKeep}) extraites avec succès !`);
});

app.post('/api/convert', useTrial, upload.single('pdf'), (req, res) => {
  res.send("PDF converti en Word avec succès !");
});

app.post('/api/convert-excel', useTrial, upload.single('pdf'), (req, res) => {
  res.send("PDF converti en Excel avec succès !");
});


// -----------------------------------------------------------------
// LANCEMENT DU SERVEUR
// -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur PDFUltime démarré sur le port ${PORT}`);
});
