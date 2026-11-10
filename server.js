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
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: 'uploads/' });

app.use(cookieParser());

// ==========================================
// SÉCURITÉ MIDDLEWARE EXPRESS JSON & WEBHOOK
// ==========================================
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json({
      limit: '1mb',
      verify: (req, res, buf) => {
        try {
          JSON.parse(buf);
        } catch (e) {
          res.status(400).json({ error: 'Requête JSON invalide' });
          throw new Error('Invalid JSON');
        }
      }
    })(req, res, next);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

let db;

async function initDB() {
  db = await open({
    filename: path.join(__dirname, 'database.sqlite'),
    driver: sqlite3.Database
  });

  // Ajout de la colonne planType pour le cloisonnement des rôles
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      uuid TEXT PRIMARY KEY,
      trials INTEGER DEFAULT 3,
      expiresAt DATETIME,
      planType TEXT
    )
  `);
  console.log("📂 Base de données SQLite initialisée avec succès (avec cloisonnement des rôles).");
}
initDB();

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
// MIDDLEWARES DE SÉCURITÉ & CLOISONNEMENT
// ==========================================
async function checkAccess(req, res, next, requiredCategory = null) {
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
    await db.run(`INSERT INTO users (uuid, trials, expiresAt, planType) VALUES (?, 3, NULL, NULL)`, [userUuid]);
    user = { trials: 3, expiresAt: null, planType: null };
  }

  const now = Date.now();

  // Si l'utilisateur a un pass payant actif
  if (user.expiresAt && now < user.expiresAt) {
    // Vérification du cloisonnement si une catégorie spécifique est exigée
    if (requiredCategory && user.planType !== requiredCategory) {
      return res.status(403).json({ 
        error: "restricted_category", 
        message: `Votre pass actuel (${user.planType}) ne vous donne pas accès à cet espace. Veuillez souscrire au pass de cette catégorie.` 
      });
    }
    return next();
  }

  // S'il n'a plus d'essais gratuits
  if (user.trials <= 0) {
    return res.status(403).json({ 
      error: "trial_expired", 
      message: "Vous avez épuisé vos 3 essais gratuits ! Veuillez choisir un pass pour continuer." 
    });
  }

  // Consommation d'un essai gratuit
  await db.run(`UPDATE users SET trials = trials - 1 WHERE uuid = ?`, [userUuid]);
  console.log(`[Essai Consommé] UUID: ${userUuid} | Restants: ${user.trials - 1}`);
  
  next();
}

// Middleware spécifiques par espace
const checkStudentAccess = (req, res, next) => checkAccess(req, res, next, 'etudiant');
const checkComptableAccess = (req, res, next) => checkAccess(req, res, next, 'comptable');
const checkImmoAccess = (req, res, next) => checkAccess(req, res, next, 'immobilier');
const checkGeneralAccess = (req, res, next) => checkAccess(req, res, next, null);

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
  res.json({ trials: user.trials, isPaid, planType: user.planType });
});

// ==========================================
// WEBHOOK STRIPE (Enregistre le type de pass)
// ==========================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Erreur de signature Webhook : ${err.message}`);
    return res.status(400).send(`Erreur Webhook : ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userUuid = session.metadata?.userUuid;
    const plan = session.metadata?.plan;

    if (userUuid) {
      const now = Date.now();
      let durationMs = 30 * 24 * 60 * 60 * 1000; // Par défaut 1 mois

      if (plan && plan.includes('24h')) durationMs = 24 * 60 * 60 * 1000;
      else if (plan && plan.includes('week')) durationMs = 7 * 24 * 60 * 60 * 1000;

      const expiresAt = now + durationMs;

      // Détermination de la catégorie pour le cloisonnement
      let planCategory = 'etudiant';
      if (plan && plan.includes('comptable')) planCategory = 'comptable';
      else if (plan && plan.includes('immo')) planCategory = 'immobilier';

      await db.run(`UPDATE users SET expiresAt = ?, planType = ? WHERE uuid = ?`, [expiresAt, planCategory, userUuid]);
      console.log(`✅ [Pass Activé & Cloisonné] UUID ${userUuid} | Catégorie: ${planCategory}`);
    }
  }

  res.json({ received: true });
});

// ==========================================
// ROUTES OUTILS PDF (Sécurisées par niveau)
// ==========================================
app.post('/api/merge', upload.array('pdfs'), checkGeneralAccess, async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).send('Veuillez sélectionner au moins 2 fichiers PDF valides.');
    }

    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      try {
        const pdfBytes = fs.readFileSync(file.path);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const pageIndices = pdfDoc.getPageIndices();
        const copiedPages = await mergedPdf.copyPages(pdfDoc, pageIndices);
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      } catch (innerErr) {
        console.error("Erreur sur un fichier source :", innerErr);
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    res.setHeader('Content-Disposition', 'attachment; filename=fusionne.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(mergedPdfBytes));
    
    req.files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e){} });
  } catch (error) {
    console.error("Erreur critique fusion:", error);
    if (req.files) {
      req.files.forEach(file => { try { fs.unlinkSync(file.path); } catch(e){} });
    }
    res.status(500).send('Erreur lors de la fusion des PDF.');
  }
});

app.post('/api/extract-pages', upload.single('pdf'), checkGeneralAccess, async (req, res) => {
  try {
    if (!req.file || !req.body.pages) return res.status(400).send('Paramètres manquants.');
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const subPdf = await PDFDocument.create();
    const pagesInput = req.body.pages.split(',').map(p => parseInt(p.trim()) - 1);
    const copiedPages = await subPdf.copyPages(pdfDoc, pagesInput);
    copiedPages.forEach(page => subPdf.addPage(page));
    const subPdfBytes = await subPdf.save();
    res.setHeader('Content-Disposition', 'attachment; filename=extrait.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(subPdfBytes));
    try { fs.unlinkSync(req.file.path); } catch(e){}
  } catch (error) {
    console.error(error);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
    res.status(500).send('Erreur lors de l’extraction.');
  }
});

app.post('/api/compress', upload.single('pdf'), checkGeneralAccess, async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Fichier manquant.');
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const compressedPdfBytes = await pdfDoc.save({ useObjectStreams: true });
    res.setHeader('Content-Disposition', 'attachment; filename=compresse.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(compressedPdfBytes));
    try { fs.unlinkSync(req.file.path); } catch(e){}
  } catch (error) {
    console.error(error);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
    res.status(500).send('Erreur lors de la compression.');
  }
});

app.post('/api/convert', upload.single('pdf'), checkGeneralAccess, async (req, res) => {
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
    try { fs.unlinkSync(req.file.path); } catch(e){}
  } catch (error) {
    console.error(error);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
    res.status(500).send('Erreur lors de la conversion Word.');
  }
});

app.post('/api/convert-excel', upload.single('pdf'), checkGeneralAccess, async (req, res) => {
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

    try { fs.unlinkSync(req.file.path); } catch(e){}
  } catch (error) {
    console.error(error);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
    res.status(500).send('Erreur lors de la conversion vers Excel.');
  }
});

// ==========================================
// ROUTES POUR LES PAGES DE NICHES SEO
// ==========================================
app.get('/etudiant', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/comptable', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/immobilier', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur PDFULTIME démarré sur http://localhost:${PORT}`);
});
