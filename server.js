const sqlite3 = require("sqlite3");
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { open } = require('sqlite');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cookieParser());

// Middleware pour gérer le corps brut sur le webhook Stripe et JSON ailleurs
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

let db;

// ==========================================
// INITIALISATION DE LA BASE DE DONNÉES SQLITE
// ==========================================
async function initDB() {
  db = await open({ driver: sqlite3.Database,
    filename: path.join(__dirname, 'database.sqlite'),
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      uuid TEXT PRIMARY KEY,
      trials INTEGER DEFAULT 3,
      expiresAt DATETIME
    )
  `);
  console.log("📂 Base de données SQLite initialisée avec succès.");
}
initDB();

// ==========================================
// GESTION DU DOSSIER UPLOADS & NETTOYAGE AUTO
// ==========================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Nettoyage automatique du dossier uploads toutes les 30 minutes (Supprime les fichiers de plus d'1h)
setInterval(() => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      if (file === '.gitkeep') return;
      const filePath = path.join(uploadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (Date.now() - stats.mtimeMs > 3600000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 30 * 60 * 1000);

// ==========================================
// MIDDLEWARE DE SÉCURITÉ (Cookies + SQLite)
// ==========================================
async function checkAccess(req, res, next) {
  let userUuid = req.cookies.pdf_ultime_user;

  if (!userUuid) {
    userUuid = crypto.randomUUID();
    res.cookie('pdf_ultime_user', userUuid, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    });
  }

  let user = await db.get(`SELECT * FROM users WHERE uuid = ?`, [userUuid]);

  if (!user) {
    await db.run(`INSERT INTO users (uuid, trials, expiresAt) VALUES (?, 3, NULL)`, [userUuid]);
    user = { trials: 3, expiresAt: null };
  }

  const now = Date.now();

  // 1. Vérifier si un pass payant est actif
  if (user.expiresAt && now < user.expiresAt) {
    return next();
  }

  // 2. Vérifier s'il reste des essais gratuits
  if (user.trials <= 0) {
    return res.status(403).json({ 
      error: "trial_expired", 
      message: "Vous avez épuisé vos 3 essais gratuits ! Veuillez choisir un pass pour continuer." 
    });
  }

  // 3. Décrémenter un essai gratuit
  await db.run(`UPDATE users SET trials = trials - 1 WHERE uuid = ?`, [userUuid]);
  console.log(`[Essai Consommé] UUID: ${userUuid} | Restants: ${user.trials - 1}`);
  
  next();
}

// Route pour connaître le statut des essais ou de l'abonnement
app.get('/api/status', async (req, res) => {
  let userUuid = req.cookies.pdf_ultime_user;
  if (!userUuid) {
    return res.json({ trials: 3, isPaid: false });
  }

  let user = await db.get(`SELECT * FROM users WHERE uuid = ?`, [userUuid]);
  if (!user) {
    return res.json({ trials: 3, isPaid: false });
  }

  const isPaid = user.expiresAt && Date.now() < user.expiresAt;
  res.json({ trials: user.trials, isPaid });
});

// ==========================================
// ROUTES STRIPE : CRÉATION DE PAIEMENT
// ==========================================
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan } = req.body;
    const userUuid = req.cookies.pdf_ultime_user;

    let priceData = {};
    if (plan === '24h') {
      priceData = { currency: 'eur', unit_amount: 299, product_data: { name: 'Pass 24h - PDFULTIME' } };
    } else if (plan === 'week') {
      priceData = { currency: 'eur', unit_amount: 499, product_data: { name: 'Pass 1 Semaine - PDFULTIME' } };
    } else if (plan === 'month') {
      priceData = { currency: 'eur', unit_amount: 999, product_data: { name: 'Pass 1 Mois (Pro) - PDFULTIME' } };
    } else {
      return res.status(400).send('Offre invalide.');
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: priceData, quantity: 1 }],
      mode: 'payment',
      success_url: `http://localhost:3000/?success=true`,
      cancel_url: `http://localhost:3000/?canceled=true`,
      metadata: { userUuid, plan }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Erreur Stripe :', error);
    res.status(500).send('Erreur session de paiement.');
  }
});

// ==========================================
// WEBHOOK STRIPE : VALIDATION DU PAIEMENT
// ==========================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = req.body;

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userUuid = session.metadata.userUuid;
    const plan = session.metadata.plan;

    if (userUuid) {
      const now = Date.now();
      let durationMs = 0;

      if (plan === '24h') durationMs = 24 * 60 * 60 * 1000;
      else if (plan === 'week') durationMs = 7 * 24 * 60 * 60 * 1000;
      else if (plan === 'month') durationMs = 30 * 24 * 60 * 60 * 1000;

      const expiresAt = now + durationMs;

      await db.run(`UPDATE users SET expiresAt = ? WHERE uuid = ?`, [expiresAt, userUuid]);
      console.log(`✅ [Pass Activé en BDD] UUID ${userUuid} pour le plan ${plan}`);
    }
  }

  res.json({ received: true });
});

// ==========================================
// ROUTES OUTILS PDF (Protéges par checkAccess)
// ==========================================

app.post('/api/merge', upload.array('pdfs'), checkAccess, async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) return res.status(400).send('Fichiers insuffisants.');
    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdfBytes = fs.readFileSync(file.path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPagesIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    const mergedPdfBytes = await mergedPdf.save();
    res.setHeader('Content-Disposition', 'attachment; filename=fusionne.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(mergedPdfBytes));
    req.files.forEach(file => fs.unlinkSync(file.path));
  } catch (error) {
    res.status(500).send('Erreur lors de la fusion.');
  }
});

app.post('/api/extract-pages', upload.single('pdf'), checkAccess, async (req, res) => {
  try {
    if (!req.file || !req.body.pages) return res.status(400).send('Paramètres manquants.');
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const subPdf = await PDFDocument.create();
    const pagesInput = req.body.pages.split(',').map(p => parseInt(p.trim()) - 1);
    const copiedPages = await subPdf.copyPages(pdfDoc, pagesInput);
    copiedPages.forEach(page => subPdf.addPage(page));
    const subPdfBytes = await subPdf.save();
    res.setHeader('Content-Disposition', 'attachment; filename=extrait.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(subPdfBytes));
    fs.unlinkSync(req.file.path);
  } catch (error) {
    res.status(500).send('Erreur lors de l’extraction.');
  }
});

app.post('/api/compress', upload.single('pdf'), checkAccess, async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Fichier manquant.');
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const compressedPdfBytes = await pdfDoc.save({ useObjectStreams: true });
    res.setHeader('Content-Disposition', 'attachment; filename=compresse.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(compressedPdfBytes));
    fs.unlinkSync(req.file.path);
  } catch (error) {
    res.status(500).send('Erreur lors de la compression.');
  }
});

app.post('/api/convert', upload.single('pdf'), checkAccess, async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Fichier manquant.');
    const pdfBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(pdfBuffer);
    const doc = new Document({
      sections: [{
        children: pdfData.text.split('\n').map(line => new Paragraph({
          children: [new TextRun({ text: line, font: "Calibri", size: 24 })],
          spacing: { after: 120 }
        }))
      }]
    });
    const b64string = await Packer.toBuffer(doc);
    res.setHeader('Content-Disposition', 'attachment; filename=document-converti.docx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(b64string);
    fs.unlinkSync(req.file.path);
  } catch (error) {
    res.status(500).send('Erreur lors de la conversion Word.');
  }
});

app.post('/api/convert-excel', upload.single('pdf'), checkAccess, async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Fichier manquant.');
    
    const pdfBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(pdfBuffer);
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Données PDF');

    const lines = pdfData.text.split('\n');
    lines.forEach((line) => {
      if (line.trim() !== '') {
        worksheet.addRow([line.trim()]);
      }
    });

    res.setHeader('Content-Disposition', 'attachment; filename=document-converti.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    await workbook.xlsx.write(res);
    res.end();

    fs.unlinkSync(req.file.path);
  } catch (error) {
    console.error(error);
    res.status(500).send('Erreur lors de la conversion vers Excel.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur PDFULTIME démarré sur http://localhost:${PORT}`);
});