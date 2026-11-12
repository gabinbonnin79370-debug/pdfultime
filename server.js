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

// Création des tables : gestion par email pour les essais et stockage des avis
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    trials_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// Fichiers statiques (dossier "public" pour tes fichiers HTML/CSS/JS)
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

// API : Enregistrer ou vérifier l'e-mail de l'utilisateur pour les essais gratuits
app.post('/api/auth/register-trial', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: "E-mail invalide." });
  }

  db.get(`SELECT trials_count FROM users WHERE email = ?`, [email], (err, row) => {
    if (err) return res.status(500).json({ error: "Erreur serveur" });

    if (!row) {
      // Nouvel utilisateur : on l'ajoute avec 0 essai utilisé
      db.run(`INSERT INTO users (email, trials_count) VALUES (?, 0)`, [email], (err) => {
        if (err) return res.status(500).json({ error: "Erreur serveur" });
        res.json({ success: true, trialsRemaining: 5 });
      });
    } else {
      // Utilisateur existant : on calcule ses essais restants (max 5)
      let remaining = Math.max(0, 5 - row.trials_count);
      res.json({ success: true, trialsRemaining: remaining });
    }
  });
});

// API : Route de fusion (vérifie l'email et incrémente les essais)
app.post('/api/merge', upload.array('pdfs'), (req, res) => {
  const email = req.body.email;
  if (!email) {
    return res.status(401).json({ error: "E-mail requis pour lancer l'action." });
  }

  db.get(`SELECT trials_count FROM users WHERE email = ?`, [email], (err, row) => {
    let currentCount = row ? row.trials_count : 0;

    if (currentCount >= 5) {
      return res.status(403).json({ error: "Limite de 5 essais gratuits atteinte. Passez au mode Premium." });
    }

    // Incrémente le compteur pour cet email
    db.run(`UPDATE users SET trials_count = trials_count + 1 WHERE email = ?`, [email], (err) => {
      if (err) console.error(err);
      
      // TODO: Insérer ici ta logique de traitement PDF (fusion avec pdf-lib ou autre)
      
      res.json({ success: true, message: "Fichiers fusionnés avec succès !" });
    });
  });
});

// API : Route de compression
app.post('/api/compress', upload.single('pdf'), (req, res) => {
  const email = req.body.email;
  if (!email) {
    return res.status(401).json({ error: "E-mail requis pour lancer l'action." });
  }

  db.get(`SELECT trials_count FROM users WHERE email = ?`, [email], (err, row) => {
    let currentCount = row ? row.trials_count : 0;

    if (currentCount >= 5) {
      return res.status(403).json({ error: "Limite de 5 essais gratuits atteinte. Passez au mode Premium." });
    }

    db.run(`UPDATE users SET trials_count = trials_count + 1 WHERE email = ?`, [email], (err) => {
      if (err) console.error(err);

      // TODO: Insérer ici ta logique de compression PDF

      res.json({ success: true, message: "Fichier compressé avec succès !" });
    });
  });
});


// -----------------------------------------------------------------
// LANCEMENT DU SERVEUR
// -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur PDFUltime démarré sur le port ${PORT}`);
});
