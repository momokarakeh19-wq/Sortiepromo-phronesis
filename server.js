require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Configuration ----------
const PRICE_PER_TICKET = parseInt(process.env.PRICE_PER_TICKET || '3000', 10);
const MAX_TICKETS = parseInt(process.env.MAX_TICKETS || '10', 10);
const SALE_DEADLINE = process.env.SALE_DEADLINE || '2026-07-26T23:59:59';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'PHRONESIS <onboarding@resend.dev>';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

const DATA_FILE = path.join(__dirname, 'data', 'orders.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]');
}

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
}

app.use('/api/webhooks/paytech', express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================================
// 1. WEBHOOK (IPN) PAYTECH
// =====================================================================
app.post('/api/webhooks/paytech', async (req, res) => {
  try {
    const { type_event, ref_command } = req.body;
    console.log(`Notification IPN PayTech : ${ref_command} (${type_event})`);

    const orders = readOrders();
    const order = orders.find((o) => o.orderReference === ref_command);

    if (!order) return res.status(200).send('Order not found');
    if (order.status === 'paid' || order.status === 'failed') return res.status(200).send('Already processed');

    if (type_event === 'sale_complete') {
      order.status = 'paid';
      order.paidAt = new Date().toISOString();
      writeOrders(orders);
      sendTicketEmail(order).catch((err) => console.error('Erreur email:', err));
    } else {
      order.status = 'failed';
      writeOrders(orders);
    }
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erreur Webhook:', err);
    return res.status(200).send('Error');
  }
});

// =====================================================================
// 2. INITIALISATION DU PAIEMENT PAYTECH
// =====================================================================
app.post('/api/orders', (req, res) => {
  try {
    const { firstName, lastName, email, phone, quantity } = req.body;

    if (!firstName || !lastName || !email || !phone || !quantity) {
      return res.status(400).json({ error: 'Tous les champs sont requis.' });
    }

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1 || qty > MAX_TICKETS) {
      return res.status(400).json({ error: 'Quantité invalide.' });
    }

    if (new Date() > new Date(SALE_DEADLINE)) {
      return res.status(400).json({ error: 'La vente est terminée.' });
    }

    const amount = qty * PRICE_PER_TICKET;
    const orderReference = `PHR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const paymentData = JSON.stringify({
      item_name: `Ticket Sortie Promo Phronesis (${qty})`,
      item_price: amount,
      currency: 'XOF',
      ref_command: orderReference,
      command_name: `Achat de ${qty} ticket(s) - Cérémonie PHRONESIS`,
      env: 'live',
      success_url: `${BASE_URL}/success.html?ref=${orderReference}`,
      cancel_url: `${BASE_URL}/cancel.html`
    });

    const options = {
      hostname: 'paytech.sn',
      port: 443,
      path: '/api/payment/request-payment',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'API_KEY': process.env.PAYTECH_API_KEY,
        'API_SECRET': process.env.PAYTECH_API_SECRET,
        'Content-Length': Buffer.byteLength(paymentData)
      }
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const paytechData = JSON.parse(data);
          if (paytechData.success === 1) {
            const orders = readOrders();
            orders.push({
              orderReference,
              firstName,
              lastName,
              email,
              phone,
              quantity: qty,
              amount,
              status: 'pending',
              createdAt: new Date().toISOString(),
            });
            writeOrders(orders);

            return res.json({ checkoutUrl: paytechData.redirect_url });
          } else {
            console.error('PayTech refus:', paytechData);
            return res.status(400).json({ error: 'Échec de l’initialisation du paiement.' });
          }
        } catch (parseErr) {
          console.error('Erreur de lecture PayTech:', data);
          return res.status(500).json({ error: 'Erreur de communication avec le processeur.' });
        }
      });
    });

    request.on('error', (err) => {
      console.error('Erreur réseau PayTech:', err);
      return res.status(500).json({ error: 'Erreur de connexion aux services de paiement.' });
    });

    request.write(paymentData);
    request.end();

  } catch (err) {
    console.error('Erreur interne:', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// =====================================================================
// 3. ENVOI DE L'EMAIL (Resend)
// =====================================================================
async function sendTicketEmail(order) {
  if (!RESEND_API_KEY) return;

  const ticketPath = path.join(__dirname, 'public', 'ticket.jpg');
  if (!fs.existsSync(ticketPath)) return;
  const ticketBase64 = fs.readFileSync(ticketPath).toString('base64');

  const emailData = JSON.stringify({
    from: EMAIL_FROM,
    to: order.email,
    subject: 'Votre ticket - Cérémonie PHRONESIS',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Merci ${order.firstName} ${order.lastName} !</h2>
        <p>Votre paiement de <strong>${order.amount} FCFA</strong> pour <strong>${order.quantity} ticket(s)</strong> a bien été confirmé.</p>
        <p><strong>Référence :</strong> ${order.orderReference}</p>
        <p>📅 Dimanche 26 juillet 2026 — Théâtre National Daniel Sorano à 13h00</p>
      </div>
    `,
    attachments: [{ filename: 'ticket-phronesis.jpg', content: ticketBase64 }]
  });

  const options = {
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(emailData)
    }
  };

  const req = https.request(options);
  req.write(emailData);
  req.end();
}

// =====================================================================
// 4. PANNEAU D'ADMINISTRATION
// =====================================================================
app.get('/admin', (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.send(`
      <html><body style="font-family:Arial;max-width:400px;margin:80px auto;text-align:center;">
        <h2>Accès admin</h2>
        <form method="GET" action="/admin">
          <input type="password" name="password" placeholder="Mot de passe" style="padding:10px;width:100%;box-sizing:border-box;margin-bottom:10px;" />
          <button type="submit" style="padding:10px 20px;width:100%;">Entrer</button>
        </form>
      </body></html>
    `);
  }

  const orders = readOrders();
  const paid = orders.filter((o) => o.status === 'paid');
  const totalTickets = paid.reduce((sum, o) => sum + o.quantity, 0);
  const totalAmount = paid.reduce((sum, o) => sum + o.amount, 0);

  const rows = paid
    .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt))
    .map((o, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${o.firstName} ${o.lastName}</td>
        <td>${o.email}</td>
        <td>${o.phone}</td>
        <td>${o.quantity}</td>
        <td>${o.amount} FCFA</td>
        <td>${new Date(o.paidAt).toLocaleString('fr-FR')}</td>
      </tr>`).join('');

  res.send(`
    <html>
    <head><meta charset="utf-8"><title>Admin - Tickets PHRONESIS</title></head>
    <body style="font-family:Arial;max-width:900px;margin:30px auto;padding:0 15px;">
      <h2>Liste des tickets payés</h2>
      <p><strong>${paid.length}</strong> commandes payées — <strong>${totalTickets}</strong> tickets vendus — <strong>${totalAmount}</strong> FCFA encaissés</p>
      <table border="1" cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="background:#eee;">
          <th>#</th><th>Nom</th><th>Email</th><th>Téléphone</th><th>Tickets</th><th>Montant</th><th>Payé le</th>
        </tr>
        ${rows}
      </table>
    </body>
    </html>
  `);
});

app.get('/api/config', (req, res) => {
  res.json({ pricePerTicket: PRICE_PER_TICKET, maxTickets: MAX_TICKETS, saleDeadline: SALE_DEADLINE });
});

app.listen(PORT, () => {
  console.log(`Serveur Phronesis actif sur le port ${PORT}`);
});

