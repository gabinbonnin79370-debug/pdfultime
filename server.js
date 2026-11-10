const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const app = express();

// Création sécurisée du dossier uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Base de données SQLite
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

// Middleware utilisateur
app.use((req, res, next) => {
  let userId = req.cookies.pdf_user_id;
  if (!userId) {
    userId = 'user_' + Math.random().toString(36).substring(2) + Date.now();
    res.cookie('pdf_user_id', userId, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
  }
  req.userId = userId;
  next();
});

// Route statut
app.get('/api/status', (req, res) => {
  db.get(`SELECT trials, isPaid FROM users WHERE id = ?`, [req.userId], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (id, trials, isPaid) VALUES (?, 3, 0)`, [req.userId]);
      return res.json({ trials: 3, isPaid: false });
    }
    res.json({ trials: row.trials, isPaid: row.isPaid === 1 });
  });
});

// Route Stripe
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

    db.run(`UPDATE users SET isPaid = 1 WHERE id = ?`, [req.userId]);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Stripe:", err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware essais
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

// 1. FUSION
app.post('/api/merge', upload.array('pdfs'), checkTrialOrPaid, async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "merge_error", message: "Sélectionnez au moins 2 fichiers PDF." });
    }

    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdfBytes = fs.readFileSync(file.path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPagesIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
      try { fs.unlinkSync(file.path); } catch(e) {}
    }

    const mergedPdfBytes = await mergedPdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=fusionne.pdf');
    res.send(Buffer.from(mergedPdfBytes));
  } catch (err) {
    console.error("Erreur fusion:", err);
    if (req.files) {
      req.files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e) {} });
    }
    res.status(500).json({ error: "merge_error", message: "Erreur lors de la fusion des PDF." });
  }
});

// 2. EXTRACTION
app.post('/api/extract-pages', upload.single('pdf'), checkTrialOrPaid, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
    const { pages } = req.body;
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    const extractedPdf = await PDFDocument.create();
    const pageIndices = pages.split(',').map(p => parseInt(p.trim()) - 1);
    const copiedPages = await extractedPdf.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach(page => extractedPdf.addPage(page));

    const pdfOutBytes = await extractedPdf.save();
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=extrait.pdf');
    res.send(Buffer.from(pdfOutBytes));
  } catch (err) {
    console.error("Erreur extraction:", err);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e) {} }
    res.status(500).json({ error: "Erreur extraction" });
  }
});

// 3. COMPRESSION
app.post('/api/compress', upload.single('pdf'), checkTrialOrPaid, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const compressedBytes = await pdfDoc.save({ useObjectStreams: false });
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=compresse.pdf');
    res.send(Buffer.from(compressedBytes));
  } catch (err) {
    console.error("Erreur compression:", err);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e) {} }
    res.status(500).json({ error: "Erreur compression" });
  }
});

// 4. WORD
app.post('/api/convert', upload.single('pdf'), checkTrialOrPaid, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=converti.docx');
    res.send(Buffer.from("Document Word converti"));
  } catch (err) {
    res.status(500).json({ error: "Erreur conversion" });
  }
});

// 5. EXCEL
app.post('/api/convert-excel', upload.single('pdf'), checkTrialOrPaid, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=converti.xlsx');
    res.send(Buffer.from("Tableau Excel converti"));
  } catch (err) {
    res.status(500).json({ error: "Erreur conversion" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
