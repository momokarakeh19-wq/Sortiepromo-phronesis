require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Configuration ----------
const PRICE_PER_TICKET = parseInt(process.env.PRICE_PER_TICKET || '3000', 10);
const MAX_TICKETS = parseInt(process.env.MAX_TICKETS || '10', 10);
const SALE_DEADLINE = process.env.SALE_DEADLINE || '2026-07-26T23:59:59';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;
const PAYTECH_ENV = process.env.PAYTECH_ENV || 'test';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'PHRONESIS <onboarding@resend.dev>';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PAYTECH_BASE = 'https://paytech.sn/api';

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

app.post(
  '/api/webhooks/paytech',
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const {
        type_event,
        custom_field,
        ref_command,
        item_price,
        final_item_price,
        token,
        api_key_sha256,
        api_secret_sha256,
        hmac_compute,
      } = req.body;

      let authentic = false;

      if (hmac_compute) {
        const priceUsed = final_item_price || item_price;
        const message = `${priceUsed}|${ref_command}|${PAYTECH_API_KEY}`;
        const expectedHmac = crypto
          .createHmac('sha256', PAYTECH_API_SECRET)
          .update(message)
          .digest('hex');
        authentic = expectedHmac === hmac_compute;
      } else if (api_key_sha256 && api_secret_sha256) {
        const expectedKeyHash = crypto.createHash('sha256').update(PAYTECH_API_KEY).digest('hex');
        const expectedSecretHash = crypto.createHash('sha256').update(PAYTECH_API_SECRET).digest('hex');
        authentic = expectedKeyHash === api_key_sha256 && expectedSecretHash === api_secret_sha256;
      }

      if (!authentic) {
        console.error('IPN PayTech non authentique, rejeté.');
        return res.status(403).send('Forbidden');
      }

      const orders = readOrders();
      const order = orders.find((o) => o.orderReference === ref_command);

      if (!order) {
        console.error('IPN reçu pour une commande inconnue:', ref_command);
        return res.status(200).send('OK');
      }

      if (order.status === 'paid' || order.status === 'canceled') {
        return res.status(200).send('OK');
      }

      if (type_event === 'sale_complete') {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
        order.token = token || null;
        writeOrders(orders);

        sendTicketEmail(order).catch((err) =>
          console.error('Erreur envoi email:', err)
        );
      } else if (type_event === 'sale_canceled') {
        order.status = 'canceled';
        writeOrders(orders);
      }

      return res.status(200).send('OK');
    } catch (err) {
      console.error('Erreur traitement IPN PayTech:', err);
      return res.status(500).send('Error');
    }
  }
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/orders', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, quantity } = req.body;

    if (!firstName || !lastName || !email || !phone || !quantity) {
      return res.status(400).json({ error: 'Tous les champs sont requis.' });
    }

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1 || qty > MAX_TICKETS) {
      return res.status(400).json({ error: `Le nombre de tickets doit être entre 1 et ${MAX_TICKETS}.` });
    }

    if (new Date() > new Date(SALE_DEADLINE)) {
      return res.status(400).json({ error: 'La vente des tickets est terminée.' });
    }

    const amount = qty * PRICE_PER_TICKET;
    const orderReference = `PHR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const paytechRes = await fetch(`${PAYTECH_BASE}/payment/request-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'API_KEY': PAYTECH_API_KEY,
        'API_SECRET': PAYTECH_API_SECRET,
      },
      body: JSON.stringify({
        item_name: `Ticket(s) ceremonie PHRONESIS`,
        item_price: amount,
        currency: 'XOF',
        ref_command: orderReference,
        command_name: `${qty} ticket(s) - Ceremonie PHRONESIS`,
        env: PAYTECH_ENV,
        target_payment: 'Orange Money, Wave, Free Money',
        ipn_url: `${BASE_URL}/api/webhooks/paytech`,
        success_url: `${BASE_URL}/success.html?ref=${orderReference}`,
        cancel_url: `${BASE_URL}/cancel.html`,
        custom_field: JSON.stringify({ orderReference }),
      }),
    });

    const paytechData = await paytechRes.json();

    if (paytechData.success !== 1) {
      console.error('Erreur PayTech:', paytechData);
      return res.status(400).json({ error: paytechData.message || 'Erreur lors de la création du paiement.' });
    }

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
  } catch (err) {
    console.error('Erreur création commande:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
});

async function sendTicketEmail(order) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY non configuré, email non envoyé.');
    return;
  }

  const ticketPath = path.join(__dirname, 'public', 'ticket.jpg');
  const ticketBase64 = fs.readFileSync(ticketPath).toString('base64');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Merci ${order.firstName} ${order.lastName} !</h2>
      <p>Votre paiement de <strong>${order.amount} FCFA</strong> pour <strong>${order.quantity} ticket(s)</strong>
      à la Cérémonie de Remise de Parchemins PHRONESIS a bien été confirmé.</p>
      <p><strong>Référence de commande :</strong> ${order.orderReference}</p>
      <p>Votre ticket est en pièce jointe. Présentez-vous à l'entrée avec votre nom (${order.firstName} ${order.lastName})
      le jour de l'événement.</p>
      <p>📅 Dimanche 26 juillet 2026 — Théâtre National Daniel Sorano à 13h00</p>
      <p>À bientôt !<br/>L'équipe PHRONESIS</p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: order.email,
      subject: 'Votre ticket - Cérémonie PHRONESIS',
      html,
      attachments: [
        {
          filename: 'ticket-phronesis.jpg',
          content: ticketBase64,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend a refusé l'envoi: ${errText}`);
  }
}

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
    .map(
      (o, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${o.firstName} ${o.lastName}</td>
        <td>${o.email}</td>
        <td>${o.phone}</td>
        <td>${o.quantity}</td>
        <td>${o.amount} FCFA</td>
        <td>${new Date(o.paidAt).toLocaleString('fr-FR')}</td>
      </tr>`
    )
    .join('');

  res.send(`
    <html>
    <head><meta charset="utf-8"><title>Admin - Tickets PHRONESIS</title></head>
    <body style="font-family:Arial;max-width:900px;margin:30px auto;padding:0 15px;">
      <h2>Liste des tickets payés</h2>
      <p><strong>${paid.length}</strong> commandes payées — <strong>${totalTickets}</strong> tickets vendus — <strong>${totalAmount}</strong> FCFA encaissés</p>
      <p><a href="/admin/export.csv?password=${encodeURIComponent(password)}">Télécharger en CSV</a></p>
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

app.get('/admin/export.csv', (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).send('Accès refusé');
  }
  const orders = readOrders().filter((o) => o.status === 'paid');
  let csv = 'Prenom,Nom,Email,Telephone,Tickets,Montant,Reference,PayeLe\n';
  orders.forEach((o) => {
    csv += `${o.firstName},${o.lastName},${o.email},${o.phone},${o.quantity},${o.amount},${o.orderReference},${o.paidAt}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=tickets-phronesis.csv');
  res.send(csv);
});

app.get('/api/config', (req, res) => {
  res.json({ pricePerTicket: PRICE_PER_TICKET, maxTickets: MAX_TICKETS, saleDeadline: SALE_DEADLINE });
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
