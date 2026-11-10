const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const app = express();

// Création automatique du dossier uploads s'il n'existe pas (correction du crash 502)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Base de données SQLite pour les essais et abonnements
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error('Erreur ouverture DB', err.message);
  else console.log('Connecté à la base de données SQLite.');
});

db.run(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  trials INTEGER DEFAULT 3,
  isPaid INTEGER DEFAULT 0,
  paidUntil DATETIME
)`);

// Middleware pour gérer l'utilisateur (via Cookie)
app.use((req, res, next) => {
  let userId = req.cookies.pdf_user_id;
  if (!userId) {
    userId = 'user_' + Math.random().toString(36).substring(2) + Date.now();
    res.cookie('pdf_user_id', userId, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
  }
  req.userId = userId;
  next();
});

// Route de statut
app.get('/api/status', (req, res) => {
  db.get(`SELECT trials, isPaid FROM users WHERE id = ?`, [req.userId], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (id, trials, isPaid) VALUES (?, 3, 0)`, [req.userId]);
      return res.json({ trials: 3, isPaid: false });
    }
    res.json({ trials: row.trials, isPaid: row.isPaid === 1 });
  });
});

// Route Stripe Checkout
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan } = req.body;
    let priceData = {};
    
    if (plan === '24h') {
      priceData = { currency: 'eur', unit_amount: 299, product_data: { name: 'Pass 24h PDFULTIME' } };
    } else if (plan === 'week') {
      priceData = { currency: 'eur', unit_amount: 499, product_data: { name: 'Pass 1 Semaine PDFULTIME' } };
    } else if (plan === 'month') {
      priceData = { currency: 'eur', unit_amount: 999, product_data: { name: 'Pass 1 Mois PDFULTIME' } };
    } else {
      return res.status(400).json({ error: 'Plan invalide' });
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [{ price_data: priceData, quantity: 1 }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}?success=true`,
      cancel_url: `${req.protocol}://${req.get('host')}?canceled=true`,
    });

    // Activer temporairement le compte en mode test/succès immédiat
    db.run(`UPDATE users SET isPaid = 1 WHERE id = ?`, [req.userId]);

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Stripe:", err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware de vérification des essais
const checkTrialOrPaid = (req, res, next) => {
  db.get(`SELECT trials, isPaid FROM users WHERE id = ?`, [req.userId], (err, row) => {
    if (row && row.isPaid === 1) return next();
    if (row && row.trials > 0) {
      db.run(`UPDATE users SET trials = trials - 1 WHERE id = ?`, [req.userId]);
      return next();
    }
    return res.status(403).json({ error: "trial_expired", message: "Essais gratuits épuisés." });
  });
};

// Route Fusion de PDF sécurisée
app.post('/api/merge', upload.array('pdfs'), checkTrialOrPaid, async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "merge_error", message: "Veuillez sélectionner au moins 2 fichiers PDF." });
    }

    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdfBytes = fs.readFileSync(file.path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPagesIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
      fs.unlinkSync(file.path); // Nettoyage du fichier temporaire
    }

    const mergedPdfBytes = await mergedPdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=fusionne.pdf');
    res.send(Buffer.from(mergedPdfBytes));
  } catch (err) {
    console.error("Erreur fusion:", err);
    res.status(500).json({ error: "merge_error", message: "Erreur lors de la fusion des PDF." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
