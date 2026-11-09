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

async function initDB() {
    db = await open({
        driver: sqlite3.Database,
        filename: path.join(__dirname, 'database.sqlite'),
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            uuid TEXT PRIMARY KEY,
            trials INTEGER DEFAULT 3,
            expiresAt DATETIME
        )
    `);
    console.log("Base de données SQLite initialisée avec succès.");
}
initDB();

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan } = req.body;
    let userUuid = req.cookies && req.cookies.pdf_ultime_user;

    if (!userUuid) {
      userUuid = 'user_' + Math.random().toString(36).substring(2, 15);
      res.cookie('pdf_ultime_user', userUuid, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
    }

    let user = await db.get(`SELECT * FROM users WHERE uuid = ?`, [userUuid]);
    if (!user) {
      await db.run(`INSERT INTO users (uuid, trials) VALUES (?, 3)`, [userUuid]);
      user = { uuid: userUuid, trials: 3 };
    }

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
      line_items: [{ price_data: priceData, quantity: 1 }],
      mode: 'payment',
      success_url: 'https://pdfultime.onrender.com/?success=true',
      cancel_url: 'https://pdfultime.onrender.com/',
      metadata: { userUuid, plan }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Erreur Stripe :', error);
    res.status(500).send('Erreur session de paiement.');
  }
});

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
            console.log(`[Pass Activé en BDD] UUID ${userUuid} pour le plan ${plan}`);
        }
    }
    res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
