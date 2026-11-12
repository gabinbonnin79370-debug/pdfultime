const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Chemin absolu pour la base de données (sécurisé pour Render)
const dbFile = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Erreur d\'ouverture de la base de données :', err.message);
  } else {
    console.log('Connecté à la base de données SQLite sur :', dbFile);
    
    // Création de la table users
    db.run(`CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      trials_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error("Erreur création table users:", err.message);
      else console.log("Table 'users' prête.");
    });
  }
});

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
    if (err) {
      console.error("Erreur SQL SELECT:", err.message);
      return res.status(500).json({ error: "Erreur SQL SELECT: " + err.message });
    }

    if (!row) {
      db.run(`INSERT INTO users (email, trials_count) VALUES (?, 0)`, [email], (err) => {
        if (err) {
          console.error("Erreur SQL INSERT:", err.message);
          return res.status(500).json({ error: "Erreur SQL INSERT: " + err.message });
        }
        res.json({ success: true, trialsRemaining: 5 });
      });
    } else {
      let remaining = Math.max(0, 5 - row.trials_count);
      res.json({ success: true, trialsRemaining: remaining });
    }
  });
});

// API : Route de fusion
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

    db.run(`UPDATE users SET trials_count = trials_count + 1 WHERE email = ?`, [email], (err) => {
      if (err) console.error("Erreur SQL UPDATE:", err.message);
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
      if (err) console.error("Erreur SQL UPDATE:", err.message);
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
